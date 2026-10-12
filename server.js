const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRouter } = require("./router");
const { validateConfig } = require("./validate-config");
const secretsStore = require("./secrets-store");

const DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1";

const DEFAULT_REASONING_CACHE_PATH = path.join(
  os.homedir(),
  ".claudezen",
  "reasoning-cache.json",
);

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REASONING_CACHE_MAX_ENTRIES = 0;
const DEFAULT_REASONING_CACHE_MAX_AGE_MS = 30 * DAY_MS;
const DEFAULT_REASONING_CACHE_MAX_SIZE_BYTES = 200 * 1024 * 1024;
const DEFAULT_REQUEST_BODY_LIMIT_BYTES = 100 * 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;
const CHAT_COMPLETIONS_RESPONSE_HEADERS = ["content-type", "cache-control"];

const warnedFinishReasons = new Set();

/* ============================================================
   CONFIG
   ============================================================ */

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function argValue(name) {
  const prefix = `${name}=`;

  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];

    if (arg === name) return process.argv[i + 1];
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }

  return null;
}

function expandHome(value) {
  if (!value || typeof value !== "string") return value;

  if (value === "~") return os.homedir();

  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}

function resolveMaybeRelative(value, baseDir) {
  const expanded = expandHome(value);

  if (!expanded || path.isAbsolute(expanded)) {
    return expanded;
  }

  return path.resolve(baseDir, expanded);
}

function configValue(config, keys, fallback) {
  let cursor = config;

  for (const key of keys) {
    if (
      !cursor ||
      typeof cursor !== "object" ||
      !(key in cursor)
    ) {
      return fallback;
    }

    cursor = cursor[key];
  }

  return cursor === undefined || cursor === null
    ? fallback
    : cursor;
}

function numberConfig(name, value, fallback, options = {}) {
  const number = Number(
    value === undefined || value === null
      ? fallback
      : value,
  );

  if (!Number.isFinite(number)) {
    throw new Error(
      `Invalid numeric config ${name}: ${JSON.stringify(value)}`,
    );
  }

  if (options.integer && !Number.isInteger(number)) {
    throw new Error(
      `Invalid integer config ${name}: ${JSON.stringify(value)}`,
    );
  }

  if (options.min !== undefined && number < options.min) {
    throw new Error(
      `Invalid config ${name}: ${number} is below ${options.min}`,
    );
  }

  if (options.max !== undefined && number > options.max) {
    throw new Error(
      `Invalid config ${name}: ${number} is above ${options.max}`,
    );
  }

  return number;
}

function envValue(name, fallback) {
  return Object.prototype.hasOwnProperty.call(process.env, name)
    ? process.env[name]
    : fallback;
}

function loadConfig() {
  const defaultPath = path.join(__dirname, "config.json");

  const configPath =
    process.env.CLAUDE_OPENCODE_PROXY_CONFIG ||
    process.env.CLAUDEZEN_CONFIG ||
    argValue("--config") ||
    defaultPath;

  const resolvedPath = path.resolve(configPath);
  const fileConfig = readJson(resolvedPath) || {};
  const configDir = path.dirname(resolvedPath);

  const providersConfig = configValue(
    fileConfig,
    ["providers"],
    {},
  );

  function deriveModels(providers) {
    const seen = new Set();
    const models = [];

    for (const id of Object.keys(providers)) {
      const model = providers[id]?.model;

      if (
        typeof model === "string" &&
        model &&
        !seen.has(model)
      ) {
        seen.add(model);
        models.push(model);
      }
    }

    return models;
  }

  return {
    configPath: resolvedPath,

    listenHost: envValue(
      "CLAUDE_OPENCODE_PROXY_HOST",
      configValue(
        fileConfig,
        ["listen", "host"],
        "127.0.0.1",
      ),
    ),

    port: numberConfig(
      "listen.port",
      envValue(
        "CLAUDE_OPENCODE_PROXY_PORT",
        configValue(
          fileConfig,
          ["listen", "port"],
          8787,
        ),
      ),
      8787,
      {
        integer: true,
        min: 1,
        max: 65535,
      },
    ),

    upstreamBaseUrl: normalizeBaseUrl(
      envValue(
        "CLAUDE_OPENCODE_PROXY_UPSTREAM_BASE_URL",
        configValue(
          fileConfig,
          ["upstream", "baseUrl"],
          DEFAULT_BASE_URL,
        ),
      ),
    ),

    reasoningCachePath: resolveMaybeRelative(
      envValue(
        "CLAUDE_OPENCODE_REASONING_CACHE",
        configValue(
          fileConfig,
          ["reasoningCachePath"],
          DEFAULT_REASONING_CACHE_PATH,
        ),
      ),
      configDir,
    ),

    reasoningCacheMaxEntries: numberConfig(
      "reasoningCacheMaxEntries",
      envValue(
        "CLAUDE_OPENCODE_REASONING_CACHE_MAX_ENTRIES",
        configValue(
          fileConfig,
          ["reasoningCacheMaxEntries"],
          DEFAULT_REASONING_CACHE_MAX_ENTRIES,
        ),
      ),
      DEFAULT_REASONING_CACHE_MAX_ENTRIES,
      {
        integer: true,
        min: 0,
      },
    ),

    reasoningCacheMaxAgeMs: numberConfig(
      "reasoningCacheMaxAgeMs",
      envValue(
        "CLAUDE_OPENCODE_REASONING_CACHE_MAX_AGE_MS",
        configValue(
          fileConfig,
          ["reasoningCacheMaxAgeMs"],
          DEFAULT_REASONING_CACHE_MAX_AGE_MS,
        ),
      ),
      DEFAULT_REASONING_CACHE_MAX_AGE_MS,
      {
        integer: true,
        min: 0,
      },
    ),

    reasoningCacheMaxSizeBytes: numberConfig(
      "reasoningCacheMaxSizeBytes",
      envValue(
        "CLAUDE_OPENCODE_REASONING_CACHE_MAX_SIZE_BYTES",
        configValue(
          fileConfig,
          ["reasoningCacheMaxSizeBytes"],
          DEFAULT_REASONING_CACHE_MAX_SIZE_BYTES,
        ),
      ),
      DEFAULT_REASONING_CACHE_MAX_SIZE_BYTES,
      {
        integer: true,
        min: 0,
      },
    ),

    reasoningContentMode: envValue(
      "CLAUDE_OPENCODE_REASONING_CONTENT",
      configValue(
        fileConfig,
        ["reasoningContent"],
        "auto",
      ),
    ),

    requestBodyLimitBytes: numberConfig(
      "requestBodyLimitBytes",
      envValue(
        "CLAUDE_OPENCODE_REQUEST_BODY_LIMIT_BYTES",
        configValue(
          fileConfig,
          ["requestBodyLimitBytes"],
          DEFAULT_REQUEST_BODY_LIMIT_BYTES,
        ),
      ),
      DEFAULT_REQUEST_BODY_LIMIT_BYTES,
      {
        integer: true,
        min: 1,
      },
    ),

    /*
     * Limite opcional de max_tokens enviado ao upstream.
     * 0 = desativado (repassa o valor do Claude Code).
     * Útil em planos gratuitos que reservam cota com base
     * em contexto + max_tokens.
     */
    maxOutputTokens: numberConfig(
      "maxOutputTokens",
      envValue(
        "CLAUDEZEN_MAX_OUTPUT_TOKENS",
        configValue(
          fileConfig,
          ["maxOutputTokens"],
          0,
        ),
      ),
      0,
      {
        integer: true,
        min: 0,
      },
    ),

    upstreamTimeoutMs: numberConfig(
      "upstreamTimeoutMs",
      envValue(
        "CLAUDE_OPENCODE_UPSTREAM_TIMEOUT_MS",
        configValue(
          fileConfig,
          ["upstreamTimeoutMs"],
          DEFAULT_UPSTREAM_TIMEOUT_MS,
        ),
      ),
      DEFAULT_UPSTREAM_TIMEOUT_MS,
      {
        integer: true,
        min: 0,
      },
    ),

    models:
      Array.isArray(fileConfig.models) &&
      fileConfig.models.length
        ? fileConfig.models
        : deriveModels(providersConfig),

    routing: {
      mode: String(
        configValue(
          fileConfig,
          ["routing", "mode"],
          "auto",
        ),
      ).toLowerCase(),

      largeContextThreshold: numberConfig(
        "routing.largeContextThreshold",
        configValue(
          fileConfig,
          ["routing", "largeContextThreshold"],
          100000,
        ),
        100000,
        {
          integer: true,
          min: 1,
        },
      ),

      normalProvider: String(
        configValue(
          fileConfig,
          ["routing", "normalProvider"],
          "",
        ) || "",
      ),

      largeContextProvider: String(
        configValue(
          fileConfig,
          ["routing", "largeContextProvider"],
          "",
        ) || "",
      ),

      fallbackOrder:
        Array.isArray(
          configValue(
            fileConfig,
            ["routing", "fallbackOrder"],
            null,
          ),
        )
          ? configValue(
              fileConfig,
              ["routing", "fallbackOrder"],
              [],
            )
          : [],

      cooldownSeconds: numberConfig(
        "routing.cooldownSeconds",
        configValue(
          fileConfig,
          ["routing", "cooldownSeconds"],
          300,
        ),
        300,
        {
          integer: true,
          min: 0,
        },
      ),
    },

    providers: providersConfig,

    routingStatePath: resolveMaybeRelative(
      configValue(
        fileConfig,
        ["routingStatePath"],
        "./routing-state.json",
      ),
      configDir,
    ),
  };
}

function normalizeBaseUrl(url) {
  const base = (url || DEFAULT_BASE_URL).replace(/\/+$/, "");

  return base.endsWith("/v1")
    ? base
    : `${base}/v1`;
}

let CONFIG = loadConfig();
let ROUTER = createRouter(CONFIG, { secrets: secretsStore });

const ADMIN_TOKEN =
  process.env.CLAUDEZEN_ADMIN_TOKEN ||
  crypto.randomBytes(32).toString("hex");

const ADMIN_BODY_LIMIT_BYTES =
  64 * 1024;

const ADMIN_STATIC_FILES = {
  "/admin": "index.html",
  "/admin/": "index.html",
  "/admin/admin.css": "admin.css",
  "/admin/admin.js": "admin.js",
};

const ADMIN_STATIC_TYPES = {
  "index.html": "text/html; charset=utf-8",
  "admin.css": "text/css; charset=utf-8",
  "admin.js": "text/javascript; charset=utf-8",
};

const ADMIN_STATIC_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none';";

function safeCompare(a, b) {
  const bufA =
    Buffer.from(String(a || ""));
  const bufB =
    Buffer.from(String(b || ""));

  if (bufA.length !== bufB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

const reasoningByToolCallId = new Map();
const reasoningByAssistantText = new Map();
const reasoningByToolContext = new Map();

const PLACEHOLDER_REASONING =
  "Compatibility bridge placeholder reasoning for prior assistant history.";

/* ============================================================
   REASONING CACHE
   ============================================================ */

function sha256(text) {
  return crypto
    .createHash("sha256")
    .update(text || "", "utf8")
    .digest("hex");
}

function cacheFileMtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return Date.now();
  }
}

function normalizeReasoningEntry(
  value,
  fallbackUpdatedAt = Date.now(),
) {
  if (typeof value === "string") {
    return {
      reasoning: value,
      updatedAt: fallbackUpdatedAt,
    };
  }

  if (
    !value ||
    typeof value !== "object" ||
    typeof value.reasoning !== "string"
  ) {
    return null;
  }

  const updatedAt = Number(value.updatedAt);

  return {
    reasoning: value.reasoning,
    updatedAt: Number.isFinite(updatedAt)
      ? updatedAt
      : fallbackUpdatedAt,
  };
}

function isReasoningEntryExpired(
  entry,
  now = Date.now(),
) {
  const maxAgeMs = CONFIG.reasoningCacheMaxAgeMs;

  return (
    Number.isFinite(maxAgeMs) &&
    maxAgeMs > 0 &&
    now - entry.updatedAt > maxAgeMs
  );
}

function loadReasoningCache() {
  const cache = readJson(CONFIG.reasoningCachePath);

  if (!cache || typeof cache !== "object") {
    return;
  }

  const fallbackUpdatedAt = Number.isFinite(
    Number(cache.updatedAt),
  )
    ? Number(cache.updatedAt)
    : cacheFileMtimeMs(
        CONFIG.reasoningCachePath,
      );

  for (const [id, value] of Object.entries(
    cache.toolCallReasoning || {},
  )) {
    const entry = normalizeReasoningEntry(
      value,
      fallbackUpdatedAt,
    );

    if (
      typeof id === "string" &&
      entry &&
      !isReasoningEntryExpired(entry)
    ) {
      setMapRecent(
        reasoningByToolCallId,
        id,
        entry,
        { touch: false },
      );
    }
  }

  for (const [hash, value] of Object.entries(
    cache.assistantTextReasoning || {},
  )) {
    const entry = normalizeReasoningEntry(
      value,
      fallbackUpdatedAt,
    );

    if (
      typeof hash === "string" &&
      entry &&
      !isReasoningEntryExpired(entry)
    ) {
      setMapRecent(
        reasoningByAssistantText,
        hash,
        entry,
        { touch: false },
      );
    }
  }

  for (const [hash, value] of Object.entries(
    cache.toolContextReasoning || {},
  )) {
    const entry = normalizeReasoningEntry(
      value,
      fallbackUpdatedAt,
    );

    if (
      typeof hash === "string" &&
      entry &&
      !isReasoningEntryExpired(entry)
    ) {
      setMapRecent(
        reasoningByToolContext,
        hash,
        entry,
        { touch: false },
      );
    }
  }

  trimReasoningCaches();
}

let saveReasoningTimer = null;
let reasoningCacheDirty = false;

function reasoningCachePayloadObject() {
  return {
    version: 2,
    note:
      "DeepSeek V4 reasoning_content cache for the OpenCode Go Claude Code bridge. It is required for thinking-mode tool-call history replay.",
    updatedAt: Date.now(),
    maxEntriesPerBucket:
      CONFIG.reasoningCacheMaxEntries,
    maxAgeMs:
      CONFIG.reasoningCacheMaxAgeMs,
    maxSizeBytes:
      CONFIG.reasoningCacheMaxSizeBytes,
    toolCallReasoning:
      Object.fromEntries(
        reasoningByToolCallId.entries(),
      ),
    assistantTextReasoning:
      Object.fromEntries(
        reasoningByAssistantText.entries(),
      ),
    toolContextReasoning:
      Object.fromEntries(
        reasoningByToolContext.entries(),
      ),
  };
}

function reasoningCachePayload() {
  trimReasoningCaches();
  return reasoningCachePayloadObject();
}

function saveReasoningCacheNow() {
  try {
    const data = JSON.stringify(
      reasoningCachePayload(),
      null,
      2,
    );

    const tmp = `${CONFIG.reasoningCachePath}.tmp`;

    fs.mkdirSync(
      path.dirname(CONFIG.reasoningCachePath),
      { recursive: true },
    );

    fs.writeFileSync(
      tmp,
      data,
      "utf8",
    );

    fs.renameSync(
      tmp,
      CONFIG.reasoningCachePath,
    );

    reasoningCacheDirty = false;

    return true;
  } catch (error) {
    console.error(
      `Failed to save reasoning cache: ${error.message}`,
    );

    return false;
  }
}

function flushReasoningCache() {
  if (saveReasoningTimer) {
    clearTimeout(saveReasoningTimer);
    saveReasoningTimer = null;
  }

  if (reasoningCacheDirty) {
    saveReasoningCacheNow();
  }
}

function scheduleSaveReasoningCache() {
  reasoningCacheDirty = true;

  if (saveReasoningTimer) return;

  saveReasoningTimer = setTimeout(() => {
    saveReasoningTimer = null;
    saveReasoningCacheNow();
  }, 100);
}

function trimMap(map) {
  const maxEntries =
    CONFIG.reasoningCacheMaxEntries;

  if (!Number.isFinite(maxEntries) || maxEntries <= 0) {
    return;
  }

  while (map.size > maxEntries) {
    const oldestKey =
      map.keys().next().value;

    map.delete(oldestKey);
  }
}

function trimExpiredMap(map, now) {
  for (const [key, entry] of map.entries()) {
    if (isReasoningEntryExpired(entry, now)) {
      map.delete(key);
    }
  }
}

function reasoningCacheSerializedSize() {
  return Buffer.byteLength(
    JSON.stringify(
      reasoningCachePayloadObject(),
    ),
    "utf8",
  );
}

function deleteOldestReasoningEntry() {
  const candidates = [
    {
      name: "tool",
      map: reasoningByToolCallId,
    },
    {
      name: "assistant",
      map: reasoningByAssistantText,
    },
    {
      name: "context",
      map: reasoningByToolContext,
    },
  ];

  let oldest = null;

  for (const candidate of candidates) {
    for (const [key, entry] of candidate.map.entries()) {
      if (
        !oldest ||
        entry.updatedAt < oldest.entry.updatedAt
      ) {
        oldest = {
          ...candidate,
          key,
          entry,
        };
      }
    }
  }

  if (!oldest) return false;

  oldest.map.delete(oldest.key);

  return true;
}

function trimReasoningCacheSize() {
  const maxSizeBytes =
    CONFIG.reasoningCacheMaxSizeBytes;

  if (
    !Number.isFinite(maxSizeBytes) ||
    maxSizeBytes <= 0
  ) {
    return;
  }

  while (
    reasoningCacheSerializedSize() >
    maxSizeBytes
  ) {
    if (!deleteOldestReasoningEntry()) {
      return;
    }
  }
}

function trimReasoningCaches() {
  const now = Date.now();

  trimExpiredMap(
    reasoningByToolCallId,
    now,
  );

  trimExpiredMap(
    reasoningByAssistantText,
    now,
  );

  trimExpiredMap(
    reasoningByToolContext,
    now,
  );

  trimMap(reasoningByToolCallId);
  trimMap(reasoningByAssistantText);
  trimMap(reasoningByToolContext);

  trimReasoningCacheSize();
}

function setMapRecent(
  map,
  key,
  value,
  options = {},
) {
  const entry = normalizeReasoningEntry(value);

  if (!entry) return;

  if (options.touch !== false) {
    entry.updatedAt = Date.now();
  }

  if (map.has(key)) {
    map.delete(key);
  }

  map.set(key, entry);

  trimMap(map);
}

function getMapRecent(map, key) {
  if (!map.has(key)) return null;

  const entry = map.get(key);

  if (isReasoningEntryExpired(entry)) {
    map.delete(key);
    scheduleSaveReasoningCache();
    return null;
  }

  setMapRecent(map, key, entry);

  return entry.reasoning;
}

function setToolReasoning(id, reasoning) {
  if (!id || !reasoning) return;

  setMapRecent(
    reasoningByToolCallId,
    id,
    reasoning,
  );

  scheduleSaveReasoningCache();
}

function getToolReasoning(id) {
  if (!id) return null;

  return getMapRecent(
    reasoningByToolCallId,
    id,
  );
}

function getAssistantReasoning(text) {
  return getMapRecent(
    reasoningByAssistantText,
    sha256(text),
  );
}

function setAssistantReasoning(
  text,
  reasoning,
) {
  if (!text || !reasoning) return;

  setMapRecent(
    reasoningByAssistantText,
    sha256(text),
    reasoning,
  );

  scheduleSaveReasoningCache();
}

function toolUseSignature(tool) {
  return `tool_use:${tool.id || ""}:${tool.name || ""}:${JSON.stringify(
    tool.input || {},
  )}`;
}

function toolResultSignature(result) {
  return `tool_result:${
    result.tool_use_id ||
    result.id ||
    ""
  }:${stringifyToolResultContent(
    result.content,
  )}`;
}

function toolContextKey(
  parts,
  assistantText,
) {
  if (
    !parts ||
    !parts.length ||
    !assistantText
  ) {
    return null;
  }

  return sha256(
    `${parts.join("\n")}\nassistant:${assistantText}`,
  );
}

function getToolContextReasoning(
  parts,
  assistantText,
) {
  const key = toolContextKey(
    parts,
    assistantText,
  );

  return key
    ? getMapRecent(
        reasoningByToolContext,
        key,
      )
    : null;
}

function setToolContextReasoning(
  parts,
  assistantText,
  reasoning,
) {
  const key = toolContextKey(
    parts,
    assistantText,
  );

  if (!key || !reasoning) return;

  setMapRecent(
    reasoningByToolContext,
    key,
    reasoning,
  );

  scheduleSaveReasoningCache();
}

function currentToolContextParts(messages) {
  let hadToolCall = false;
  let parts = [];

  for (const msg of messages || []) {
    const blocks =
      Array.isArray(msg && msg.content)
        ? msg.content
        : [];

    const text =
      typeof (msg && msg.content) === "string"
        ? msg.content
        : blocks
            .filter(
              (block) =>
                block &&
                block.type === "text" &&
                typeof block.text === "string",
            )
            .map((block) => block.text)
            .join("\n");

    const toolResults = blocks.filter(
      (block) =>
        block &&
        block.type === "tool_result",
    );

    const toolUses = blocks.filter(
      (block) =>
        block &&
        block.type === "tool_use",
    );

    if (msg && msg.role === "user") {
      if (!toolResults.length && text) {
        hadToolCall = false;
        parts = [];
      }

      for (const result of toolResults) {
        if (hadToolCall) {
          parts.push(
            toolResultSignature(result),
          );
        }
      }

      continue;
    }

    if (
      msg &&
      msg.role === "assistant" &&
      toolUses.length
    ) {
      hadToolCall = true;

      parts = toolUses.map(
        toolUseSignature,
      );
    }
  }

  return hadToolCall ? parts : [];
}

/* ============================================================
   HTTP HELPERS
   ============================================================ */

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type":
      "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  });

  res.end(JSON.stringify(body));
}

function sendError(
  res,
  status,
  message,
  type = "invalid_request_error",
) {
  sendJson(res, status, {
    type: "error",
    error: {
      type,
      message,
    },
  });
}

function sendAdminJson(res, status, body) {
  res.writeHead(status, {
    "content-type":
      "application/json; charset=utf-8",
    "cache-control": "no-store",
  });

  res.end(JSON.stringify(body));
}

function sendAdminError(res, status, message) {
  sendAdminJson(res, status, {
    type: "error",
    error: {
      message,
    },
  });
}

function readAdminBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let done = false;

    function cleanup() {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    }

    function fail(error) {
      if (done) return;
      done = true;
      cleanup();
      reject(error);
      req.resume();
    }

    function onData(chunk) {
      if (done) return;
      data += chunk;

      if (
        Buffer.byteLength(data) >
        ADMIN_BODY_LIMIT_BYTES
      ) {
        const error = new Error(
          "Corpo da requisição excede o limite de 64 KB.",
        );
        error.status = 413;
        fail(error);
      }
    }

    function onEnd() {
      if (done) return;
      done = true;
      cleanup();
      resolve(data);
    }

    function onError(error) {
      fail(error);
    }

    req.setEncoding("utf8");
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

async function readAdminJsonBody(req) {
  const raw = await readAdminBody(req);
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch (error) {
    const parseError = new Error(
      `JSON inválido no corpo da requisição: ${error.message}`,
    );
    parseError.status = 400;
    throw parseError;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let done = false;

    function cleanup() {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    }

    function fail(error) {
      if (done) return;

      done = true;
      cleanup();

      reject(error);
      req.resume();
    }

    function onData(chunk) {
      if (done) return;

      data += chunk;

      if (
        data.length >
        CONFIG.requestBodyLimitBytes
      ) {
        const error = new Error(
          "Request body exceeds requestBodyLimitBytes.",
        );

        error.status = 413;
        error.type =
          "invalid_request_error";

        fail(error);
      }
    }

    function onEnd() {
      if (done) return;

      done = true;
      cleanup();

      resolve(data);
    }

    function onError(error) {
      fail(error);
    }

    req.setEncoding("utf8");

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);

  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch (error) {
    const parseError = new Error(
      `Invalid JSON request body: ${error.message}`,
    );

    parseError.status = 400;
    parseError.type =
      "invalid_request_error";

    throw parseError;
  }
}

/* ============================================================
   ANTHROPIC -> OPENAI
   ============================================================ */

function textFromAnthropicContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter(
      (block) =>
        block &&
        block.type === "text" &&
        typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

function thinkingFromAnthropicContent(content) {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter(
      (block) =>
        block &&
        block.type === "thinking" &&
        typeof block.thinking === "string",
    )
    .map((block) => block.thinking)
    .filter(Boolean)
    .join("\n");
}

function stringifyToolResultContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return JSON.stringify(content ?? "");
  }

  return content
    .map((block) => {
      if (!block) return "";

      if (block.type === "text") {
        return block.text || "";
      }

      return JSON.stringify(block);
    })
    .filter(Boolean)
    .join("\n");
}

function systemToOpenAi(system) {
  if (!system) return null;

  if (typeof system === "string") {
    return system;
  }

  if (Array.isArray(system)) {
    return textFromAnthropicContent(system);
  }

  return String(system);
}

function shouldSendReasoningContent(model) {
  const mode = String(
    CONFIG.reasoningContentMode || "auto",
  ).toLowerCase();

  if (
    ["always", "true", "on"].includes(mode)
  ) {
    return true;
  }

  if (
    ["never", "false", "off", "none"].includes(mode)
  ) {
    return false;
  }

  return isDeepSeekModel(model);
}

function isDeepSeekModel(model) {
  return (
    typeof model === "string" &&
    /(^|[-_/])deepseek/i.test(model)
  );
}

function anthropicMessagesToOpenAi(
  messages,
  includeReasoningContent,
) {
  const out = [];

  let currentUserTurnHadToolCall = false;
  let currentToolContext = [];

  for (const msg of messages || []) {
    if (!msg || !msg.role) continue;

    if (typeof msg.content === "string") {
      if (msg.role === "user") {
        currentUserTurnHadToolCall = false;
      }

      out.push({
        role: msg.role,
        content: msg.content,
      });

      continue;
    }

    const blocks =
      Array.isArray(msg.content)
        ? msg.content
        : [];

    const text = blocks
      .filter(
        (block) =>
          block &&
          block.type === "text" &&
          typeof block.text === "string",
      )
      .map((block) => block.text)
      .join("\n");

    const thinking =
      thinkingFromAnthropicContent(blocks);

    const toolResults = blocks.filter(
      (block) =>
        block &&
        block.type === "tool_result",
    );

    const toolUses = blocks.filter(
      (block) =>
        block &&
        block.type === "tool_use",
    );

    if (msg.role === "user") {
      if (toolResults.length) {
        for (const result of toolResults) {
          if (currentUserTurnHadToolCall) {
            currentToolContext.push(
              toolResultSignature(result),
            );
          }

          out.push({
            role: "tool",
            tool_call_id:
              result.tool_use_id ||
              result.id ||
              "call_unknown",
            content:
              stringifyToolResultContent(
                result.content,
              ),
          });
        }

        if (text) {
          currentUserTurnHadToolCall = false;
          currentToolContext = [];

          out.push({
            role: "user",
            content: text,
          });
        }
      } else {
        currentUserTurnHadToolCall = false;
        currentToolContext = [];

        if (text) {
          out.push({
            role: "user",
            content: text,
          });
        }
      }

      continue;
    }

    if (msg.role === "assistant") {
      const assistant = {
        role: "assistant",
        content: text || null,
      };

      if (toolUses.length) {
        currentUserTurnHadToolCall = true;

        currentToolContext =
          toolUses.map(
            toolUseSignature,
          );

        assistant.tool_calls =
          toolUses.map((tool, index) => ({
            id:
              tool.id ||
              `call_${index}`,

            type: "function",

            function: {
              name: tool.name,
              arguments: JSON.stringify(
                tool.input || {},
              ),
            },
          }));

        if (includeReasoningContent) {
          const reasoning = toolUses
            .map((tool) =>
              getToolReasoning(tool.id),
            )
            .filter(Boolean)
            .join("\n");

          assistant.reasoning_content =
            thinking ||
            reasoning ||
            PLACEHOLDER_REASONING;
        }
      } else if (
        text &&
        currentUserTurnHadToolCall
      ) {
        if (includeReasoningContent) {
          assistant.reasoning_content =
            thinking ||
            getToolContextReasoning(
              currentToolContext,
              text,
            ) ||
            getAssistantReasoning(text) ||
            PLACEHOLDER_REASONING;
        }
      }

      out.push(assistant);

      continue;
    }

    out.push({
      role: msg.role,
      content: text,
    });
  }

  return sanitizeOpenAiToolMessageSequence(
    coalesceAdjacentAssistantToolCalls(out),
  );
}

function mergeAssistantContent(
  left,
  right,
) {
  const parts = [];

  if (
    typeof left === "string" &&
    left
  ) {
    parts.push(left);
  }

  if (
    typeof right === "string" &&
    right
  ) {
    parts.push(right);
  }

  return parts.length
    ? parts.join("\n")
    : null;
}

function coalesceAdjacentAssistantToolCalls(
  messages,
) {
  const out = [];

  for (const msg of messages) {
    const prev =
      out[out.length - 1];

    if (
      prev &&
      msg &&
      prev.role === "assistant" &&
      msg.role === "assistant" &&
      Array.isArray(prev.tool_calls) &&
      prev.tool_calls.length &&
      Array.isArray(msg.tool_calls) &&
      msg.tool_calls.length
    ) {
      prev.content =
        mergeAssistantContent(
          prev.content,
          msg.content,
        );

      prev.tool_calls.push(
        ...msg.tool_calls,
      );

      if (msg.reasoning_content) {
        prev.reasoning_content = [
          prev.reasoning_content,
          msg.reasoning_content,
        ]
          .filter(Boolean)
          .join("\n");
      }

      continue;
    }

    out.push(msg);
  }

  return out;
}

function assistantWithoutToolCalls(message) {
  if (
    !message ||
    message.role !== "assistant"
  ) {
    return null;
  }

  const out = { ...message };

  delete out.tool_calls;

  if (
    out.content === null ||
    out.content === undefined ||
    out.content === ""
  ) {
    return null;
  }

  return out;
}

function orphanToolMessageToUser(message) {
  if (
    !message ||
    message.role !== "tool"
  ) {
    return null;
  }

  const id =
    message.tool_call_id ||
    "unknown";

  const content =
    typeof message.content === "string"
      ? message.content
      : JSON.stringify(
          message.content || "",
        );

  return {
    role: "user",
    content:
      `Tool result without a matching tool call (${id}):\n${content}`,
  };
}

function sanitizeOpenAiToolMessageSequence(
  messages,
) {
  const out = [];

  for (
    let i = 0;
    i < messages.length;
    i += 1
  ) {
    const message = messages[i];

    const toolCalls =
      Array.isArray(
        message && message.tool_calls,
      )
        ? message.tool_calls
        : [];

    if (
      message &&
      message.role === "assistant" &&
      toolCalls.length
    ) {
      const toolMessages = [];

      let j = i + 1;

      while (
        j < messages.length &&
        messages[j] &&
        messages[j].role === "tool"
      ) {
        toolMessages.push(messages[j]);
        j += 1;
      }

      if (
        !toolMessages.length &&
        j === messages.length
      ) {
        out.push(message);
        continue;
      }

      const expectedIds = new Set(
        toolCalls
          .map(
            (call) =>
              call && call.id,
          )
          .filter(Boolean),
      );

      const toolById = new Map();
      const orphanTools = [];

      for (const toolMessage of toolMessages) {
        const id =
          toolMessage.tool_call_id;

        if (
          expectedIds.has(id) &&
          !toolById.has(id)
        ) {
          toolById.set(
            id,
            toolMessage,
          );
        } else {
          orphanTools.push(
            toolMessage,
          );
        }
      }

      const fulfilledCalls =
        toolCalls.filter(
          (call) =>
            call &&
            toolById.has(call.id),
        );

      if (fulfilledCalls.length) {
        out.push({
          ...message,
          tool_calls:
            fulfilledCalls,
        });

        for (
          const call of fulfilledCalls
        ) {
          out.push(
            toolById.get(call.id),
          );
        }
      } else {
        const fallback =
          assistantWithoutToolCalls(
            message,
          );

        if (fallback) {
          out.push(fallback);
        }
      }

      for (const orphan of orphanTools) {
        const userMessage =
          orphanToolMessageToUser(
            orphan,
          );

        if (userMessage) {
          out.push(userMessage);
        }
      }

      i = j - 1;

      continue;
    }

    if (
      message &&
      message.role === "tool"
    ) {
      const userMessage =
        orphanToolMessageToUser(
          message,
        );

      if (userMessage) {
        out.push(userMessage);
      }

      continue;
    }

    out.push(message);
  }

  return out;
}

function anthropicToolsToOpenAi(tools) {
  if (!Array.isArray(tools)) {
    return undefined;
  }

  return tools
    .filter(
      (tool) =>
        tool && tool.name,
    )
    .map((tool) => ({
      type: "function",

      function: {
        name: tool.name,
        description:
          tool.description || "",
        parameters:
          tool.input_schema || {
            type: "object",
            properties: {},
          },
      },
    }));
}

function anthropicToolChoiceToOpenAi(
  choice,
  model,
) {
  if (
    !choice ||
    typeof choice !== "object"
  ) {
    return undefined;
  }

  if (choice.type === "auto") {
    return "auto";
  }

  if (choice.type === "none") {
    return "none";
  }

  if (isDeepSeekModel(model)) {
    return undefined;
  }

  if (choice.type === "any") {
    return "required";
  }

  if (
    choice.type === "tool" &&
    choice.name
  ) {
    return {
      type: "function",
      function: {
        name: choice.name,
      },
    };
  }

  return undefined;
}

function toolChoiceInstruction(
  choice,
  model,
) {
  if (
    !choice ||
    typeof choice !== "object"
  ) {
    return null;
  }

  if (!isDeepSeekModel(model)) {
    return null;
  }

  if (choice.type === "any") {
    return "The caller requires a tool call for this turn. Call one of the available tools instead of answering directly.";
  }

  if (
    choice.type === "tool" &&
    choice.name
  ) {
    return `The caller requires a tool call for this turn. Call the available tool named ${JSON.stringify(
      choice.name,
    )} instead of answering directly.`;
  }

  return null;
}

function thinkingToOpenAi(thinking) {
  if (
    !thinking ||
    typeof thinking !== "object"
  ) {
    return undefined;
  }

  if (
    thinking.type === "enabled" ||
    thinking.type === "disabled"
  ) {
    return {
      type: thinking.type,
    };
  }

  return undefined;
}

function reasoningEffortToOpenAi(
  outputConfig,
) {
  const effort =
    outputConfig &&
    typeof outputConfig === "object"
      ? outputConfig.effort
      : undefined;

  if (typeof effort !== "string") {
    return undefined;
  }

  const normalized =
    effort.toLowerCase();

  if (
    normalized === "max" ||
    normalized === "xhigh"
  ) {
    return "max";
  }

  if (
    normalized === "high" ||
    normalized === "medium" ||
    normalized === "low"
  ) {
    return "high";
  }

  return undefined;
}

function anthropicToOpenAi(
  body,
  stream,
) {
  const messages = [];

  const sendDeepSeekExtensions =
    isDeepSeekModel(body.model);

  const extraSystem =
    toolChoiceInstruction(
      body.tool_choice,
      body.model,
    );

  const system = [
    systemToOpenAi(body.system),
    extraSystem,
  ]
    .filter(Boolean)
    .join("\n\n");

  if (system) {
    messages.push({
      role: "system",
      content: system,
    });
  }

  messages.push(
    ...anthropicMessagesToOpenAi(
      body.messages,
      shouldSendReasoningContent(
        body.model,
      ),
    ),
  );

  const payload = {
    model: body.model,
    messages,
    stream,
    max_tokens:
      CONFIG.maxOutputTokens > 0 &&
      Number.isFinite(
        Number(body.max_tokens),
      )
        ? Math.min(
            Number(body.max_tokens),
            CONFIG.maxOutputTokens,
          )
        : body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop_sequences,
    tools: anthropicToolsToOpenAi(
      body.tools,
    ),
    tool_choice:
      anthropicToolChoiceToOpenAi(
        body.tool_choice,
        body.model,
      ),
    thinking:
      sendDeepSeekExtensions
        ? thinkingToOpenAi(
            body.thinking,
          )
        : undefined,
    reasoning_effort:
      sendDeepSeekExtensions
        ? reasoningEffortToOpenAi(
            body.output_config,
          )
        : undefined,
    stream_options: stream
      ? { include_usage: true }
      : undefined,
  };

  for (const key of Object.keys(payload)) {
    if (
      payload[key] === undefined ||
      payload[key] === null
    ) {
      delete payload[key];
    }
  }

  if (
    Array.isArray(payload.tools) &&
    payload.tools.length === 0
  ) {
    delete payload.tools;
  }

  return payload;
}

/* ============================================================
   OPENAI -> ANTHROPIC
   ============================================================ */

function parseJsonObject(text) {
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function reasoningFromMessage(message) {
  if (
    !message ||
    typeof message !== "object"
  ) {
    return "";
  }

  if (
    typeof message.reasoning_content ===
    "string"
  ) {
    return message.reasoning_content;
  }

  if (
    typeof message.reasoning === "string"
  ) {
    return message.reasoning;
  }

  if (
    message.reasoning &&
    typeof message.reasoning.content ===
      "string"
  ) {
    return message.reasoning.content;
  }

  if (
    typeof message.thinking === "string"
  ) {
    return message.thinking;
  }

  if (
    message.thinking &&
    typeof message.thinking.content ===
      "string"
  ) {
    return message.thinking.content;
  }

  return "";
}

function thinkingContentBlock(
  reasoning,
) {
  return {
    type: "thinking",
    thinking: reasoning,
    signature: "",
  };
}

function mapFinishReason(reason) {
  if (
    reason === "tool_calls" ||
    reason === "function_call"
  ) {
    return "tool_use";
  }

  if (reason === "length") {
    return "max_tokens";
  }

  if (
    reason === "stop" ||
    reason === "end_turn" ||
    reason === "content_filter"
  ) {
    return "end_turn";
  }

  if (
    reason &&
    !warnedFinishReasons.has(reason)
  ) {
    warnedFinishReasons.add(reason);

    console.warn(
      `[${new Date().toLocaleTimeString()}] ⚠️  finish_reason desconhecido do upstream: "${reason}"`,
    );
  }

  return reason || "end_turn";
}

function openAiToAnthropic(
  body,
  originalModel,
  toolContextParts = [],
) {
  const choice =
    body.choices &&
    body.choices[0]
      ? body.choices[0]
      : {};

  const message =
    choice.message || {};

  const reasoning =
    reasoningFromMessage(message);

  const content = [];

  if (reasoning) {
    content.push(
      thinkingContentBlock(
        reasoning,
      ),
    );
  }

  if (message.content) {
    if (reasoning) {
      setAssistantReasoning(
        message.content,
        reasoning,
      );

      setToolContextReasoning(
        toolContextParts,
        message.content,
        reasoning,
      );
    }

    content.push({
      type: "text",
      text: message.content,
    });
  }

  for (
    const call of message.tool_calls || []
  ) {
    if (reasoning) {
      setToolReasoning(
        call.id,
        reasoning,
      );
    }

    content.push({
      type: "tool_use",
      id: call.id,
      name:
        call.function &&
        call.function.name,
      input: parseJsonObject(
        call.function &&
          call.function.arguments,
      ),
    });
  }

  return {
    id:
      body.id ||
      `msg_${Date.now()}`,

    type: "message",
    role: "assistant",

    content,

    model:
      body.model ||
      originalModel,

    stop_reason:
      mapFinishReason(
        choice.finish_reason,
      ),

    stop_sequence: null,

    usage:
      openAiUsageToAnthropic(
        body.usage,
      ),
  };
}

/* ============================================================
   ERROR / ROUTER
   ============================================================ */

function makeAbortError(
  upstreamContext,
) {
  const error = new Error(
    upstreamContext.abortMessage,
  );

  error.status =
    upstreamContext.abortStatus;

  error.type = "proxy_error";

  return error;
}

function normalizeUpstreamError(
  error,
  upstreamContext,
) {
  if (
    upstreamContext &&
    upstreamContext.signal.aborted &&
    !error.status
  ) {
    return makeAbortError(
      upstreamContext,
    );
  }

  return error;
}

function payloadDebugSummary(
  payload,
) {
  const messages =
    Array.isArray(
      payload && payload.messages,
    )
      ? payload.messages
      : [];

  return {
    model:
      payload && payload.model,

    stream: Boolean(
      payload && payload.stream,
    ),

    message_count:
      messages.length,

    messages:
      messages.map(
        (message, index) => {
          const toolCalls =
            Array.isArray(
              message &&
                message.tool_calls,
            )
              ? message.tool_calls
              : [];

          const summary = {
            index,
            role:
              message &&
              message.role,
          };

          if (
            message &&
            message.name
          ) {
            summary.name =
              message.name;
          }

          if (
            message &&
            message.tool_call_id
          ) {
            summary.tool_call_id =
              message.tool_call_id;
          }

          if (toolCalls.length) {
            summary.tool_call_ids =
              toolCalls
                .map(
                  (call) =>
                    call && call.id,
                )
                .filter(Boolean);
          }

          return summary;
        },
      ),
  };
}

function isLoopbackAddress(
  address,
) {
  const normalized = String(
    address || "",
  ).replace(
    /^::ffff:/,
    "",
  );

  return (
    normalized === "::1" ||
    normalized === "localhost" ||
    normalized.startsWith("127.")
  );
}

function requestProcessShutdown(
  server,
) {
  setImmediate(() => {
    logShutdown(
      "Pedido local de encerramento",
    );

    flushReasoningCache();

    server.close(() => {
      console.log(
        "👋 ClaudeZen encerrado.",
      );

      process.exit(0);
    });

    setTimeout(
      () => process.exit(0),
      5000,
    ).unref();
  });
}

async function callOpenCode(
  req,
  payload,
  upstreamContext,
) {
  return ROUTER.call(
    req,
    payload,
    upstreamContext,
  );
}

/* ============================================================
   SSE
   ============================================================ */

function sse(
  res,
  event,
  data,
) {
  if (
    res.writableEnded ||
    res.destroyed
  ) {
    return;
  }

  res.write(
    `event: ${event}\n`,
  );

  res.write(
    `data: ${JSON.stringify(data)}\n\n`,
  );
}

function writeMessageStart(
  res,
  model,
) {
  const id =
    `msg_${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 8)}`;

  sse(res, "message_start", {
    type: "message_start",

    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,

      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    },
  });
}

function contentBlockStart(
  res,
  index,
  block,
) {
  sse(res, "content_block_start", {
    type: "content_block_start",
    index,
    content_block: block,
  });
}

function contentBlockDelta(
  res,
  index,
  delta,
) {
  sse(res, "content_block_delta", {
    type: "content_block_delta",
    index,
    delta,
  });
}

function contentBlockStop(
  res,
  index,
) {
  sse(res, "content_block_stop", {
    type: "content_block_stop",
    index,
  });
}

/* ============================================================
   REQUEST HELPERS
   ============================================================ */

function requestAuthToken(req) {
  const authorization =
    req.headers.authorization || "";

  if (
    authorization
      .toLowerCase()
      .startsWith("bearer ")
  ) {
    return authorization
      .slice(7)
      .trim();
  }

  return (
    req.headers["x-api-key"] ||
    ""
  );
}

function truncateForLog(
  value,
  maxLength = 500,
) {
  const text = String(
    value || "",
  );

  return text.length <= maxLength
    ? text
    : `${text.slice(0, maxLength)}...`;
}

function requestLabel(req) {
  return `${req.method || "?"} ${req.url || "?"}`;
}

/* ============================================================
   OBSERVABILITY
   ============================================================ */

const OBSERVABILITY_SESSION = {
  requests: 0,
  success: 0,
  errors: 0,
  fallbacks: 0,

  estimatedInputTokens: 0,

  actualInputTokens: 0,
  actualOutputTokens: 0,
  actualTotalTokens: 0,
};

/*
 * Estado por requisição (chave = objeto res).
 * Guarda rota/modelo/estimativa para o bloco final de usage/erro.
 */
const REQUEST_OBS = new WeakMap();

const LOG_WIDTH = 60;
const LOG_BAR = "═".repeat(LOG_WIDTH);
const LOG_LABEL_WIDTH = 20;

function formatNumber(value) {
  return Number(
    value || 0,
  ).toLocaleString("pt-BR");
}

function formatBytes(value) {
  const bytes = Number(
    value || 0,
  );

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(
      bytes / 1024
    ).toFixed(1)} KB`;
  }

  return `${(
    bytes /
    (1024 * 1024)
  ).toFixed(1)} MB`;
}

function logTitleBox(
  title,
  out = console.log,
) {
  const pad = Math.max(
    0,
    Math.floor(
      (LOG_WIDTH - title.length) / 2,
    ),
  );

  out("");
  out(LOG_BAR);
  out(`${" ".repeat(pad)}${title}`);
  out(LOG_BAR);
}

function logRow(
  label,
  value,
  out = console.log,
) {
  out(
    `   ${String(label).padEnd(
      LOG_LABEL_WIDTH,
    )}: ${value}`,
  );
}

function logSectionTitle(
  title,
  out = console.log,
) {
  out("");
  out(title);
}

function jsonLength(value) {
  try {
    return JSON.stringify(
      value === undefined
        ? null
        : value,
    ).length;
  } catch {
    return 0;
  }
}

/*
 * Divide o contexto estimado pelo router em
 * Messages / Tools / Other usando a proporção de
 * caracteres do payload. Se o router não informou
 * contextTokens, usa chars / 4 como estimativa.
 */
function analyzePayload(
  payload,
  contextTokens,
) {
  const safePayload =
    payload &&
    typeof payload === "object"
      ? payload
      : {};

  const {
    messages,
    tools,
    ...rest
  } = safePayload;

  const toolList = Array.isArray(
    tools,
  )
    ? tools
    : [];

  const messagesChars = jsonLength(
    messages || [],
  );

  const toolsChars = toolList.length
    ? jsonLength(toolList)
    : 0;

  const otherChars =
    jsonLength(rest);

  const totalChars =
    messagesChars +
    toolsChars +
    otherChars;

  const total =
    contextTokens > 0
      ? contextTokens
      : Math.ceil(totalChars / 4);

  const scale =
    totalChars > 0
      ? total / totalChars
      : 0;

  const messagesTokens = Math.round(
    messagesChars * scale,
  );

  const toolsTokens = Math.round(
    toolsChars * scale,
  );

  const otherTokens = Math.max(
    0,
    total -
      messagesTokens -
      toolsTokens,
  );

  let biggestTool = null;

  for (const tool of toolList) {
    const name =
      tool?.function?.name ||
      tool?.name ||
      "unknown";

    const tokens = Math.round(
      jsonLength(tool) * scale,
    );

    if (
      !biggestTool ||
      tokens > biggestTool.tokens
    ) {
      biggestTool = {
        name,
        tokens,
      };
    }
  }

  let payloadBytes = 0;

  try {
    payloadBytes =
      Buffer.byteLength(
        JSON.stringify(
          safePayload,
        ),
        "utf8",
      );
  } catch {
    payloadBytes = 0;
  }

  return {
    payloadBytes,
    total,
    messagesTokens,
    toolsTokens,
    otherTokens,
    toolCount: toolList.length,
    biggestTool,
  };
}

/*
 * Preferimos os números do router (routed.context),
 * que é a fonte única da estimativa. analyzePayload
 * só é usado se o router não devolver "context".
 */
function analysisFromRouter(
  routed,
  payload,
  contextTokens,
) {
  const ctx = routed?.context;

  if (
    ctx &&
    ctx.payload &&
    ctx.messages &&
    ctx.tools
  ) {
    const largest =
      ctx.tools.largest;

    return {
      payloadBytes:
        ctx.payload.bytes,

      total:
        ctx.payload.estimatedTokens,

      systemTokens:
        ctx.system?.estimatedTokens ||
        0,

      messagesTokens:
        ctx.messages.estimatedTokens,

      toolsTokens:
        ctx.tools.estimatedTokens,

      otherTokens:
        ctx.other?.estimatedTokens ||
        0,

      toolCount:
        ctx.tools.count,

      biggestTool: largest
        ? {
            name: largest.name,
            tokens: largest.tokens,
          }
        : null,
    };
  }

  const fallback =
    analyzePayload(
      payload,
      contextTokens,
    );

  return {
    ...fallback,
    systemTokens: 0,
  };
}

function statusText(status) {
  const text =
    http.STATUS_CODES[status] ||
    "";

  return `${status} ${text}`.trim();
}

function elapsedMs(res) {
  const startedAt =
    (res &&
      res.claudezenStartedAt) ||
    (REQUEST_OBS.get(res) || {})
      .startedAt;

  return startedAt
    ? Date.now() - startedAt
    : null;
}

function formatSeconds(ms) {
  return `${(
    Number(ms || 0) / 1000
  ).toLocaleString("pt-BR", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  })} s`;
}

function formatDuration(ms) {
  return Number(ms || 0) < 1000
    ? `${Math.round(Number(ms || 0))} ms`
    : formatSeconds(ms);
}

function logHttpResult(
  res,
  out = console.log,
) {
  if (!res) {
    return;
  }

  logSectionTitle("🌐 RESPOSTA", out);

  logRow(
    "Status",
    statusText(res.statusCode),
    out,
  );

  const ms = elapsedMs(res);

  if (ms !== null) {
    logSectionTitle("⏱️ TEMPO", out);

    logRow(
      "Duração total",
      formatDuration(ms),
      out,
    );
  }
}

function logRequest(
  req,
  res,
  startedAt,
) {
  const durationMs =
    Date.now() - startedAt;

  const status =
    res.statusCode;

  const ok =
    status >= 200 &&
    status < 400;

  if (ok) {
    OBSERVABILITY_SESSION.success += 1;
  }

  /*
   * Requisições que já tiveram bloco completo (sucesso)
   * ou box de erro não precisam de linha extra.
   */
  if (
    REQUEST_OBS.has(res) ||
    res.claudezenErrorLogged
  ) {
    return;
  }

  const probe =
    req.method === "HEAD" &&
    status === 404;

  const icon = ok
    ? "✓"
    : probe
      ? "ℹ️ "
      : "✗";

  const duration =
    formatDuration(durationMs);

  console.log(
    `[${new Date().toLocaleTimeString()}] ${icon} ${requestLabel(req)} → ${statusText(
      status,
    )} (${duration})`,
  );
}

function logRequestError(
  req,
  status,
  error,
  res = null,
) {
  const message =
    error && error.message
      ? error.message
      : String(error);

  OBSERVABILITY_SESSION.errors += 1;

  if (res) {
    res.claudezenErrorLogged = true;
  }

  const obs = res
    ? REQUEST_OBS.get(res)
    : null;

  logTitleBox(
    obs
      ? `CLAUDEZEN REQUEST #${obs.n} ERROR`
      : "CLAUDEZEN REQUEST ERROR",
    console.error,
  );

  logRow(
    "Request",
    requestLabel(req),
    console.error,
  );

  logRow(
    "Status",
    status,
    console.error,
  );

  if (obs) {
    logRow(
      "Provider",
      obs.provider,
      console.error,
    );

    logRow(
      "Modelo",
      obs.model,
      console.error,
    );
  }

  const ms = elapsedMs(res);

  if (ms !== null) {
    logRow(
      "Duração total",
      formatDuration(ms),
      console.error,
    );
  }

  logRow(
    "Erro",
    message,
    console.error,
  );

  console.error(LOG_BAR);
  console.error("");
}

function logObservabilityStart(
  req,
  payload,
  routed,
  res = null,
) {
  const contextTokens =
    Number(
      routed?.contextTokens || 0,
    );

  const analysis =
    analysisFromRouter(
      routed,
      payload,
      contextTokens,
    );

  const mode =
    String(
      routed?.mode ||
        "unknown",
    ).toUpperCase();

  const provider =
    routed?.provider?.name ||
    routed?.providerId ||
    "unknown";

  const model =
    routed?.model ||
    "unknown";

  const reason =
    routed?.routeReason ||
    "unknown";

  OBSERVABILITY_SESSION.requests += 1;

  OBSERVABILITY_SESSION.estimatedInputTokens +=
    analysis.total;

  const n =
    OBSERVABILITY_SESSION.requests;

  if (res) {
    REQUEST_OBS.set(res, {
      n,
      startedAt:
        res.claudezenStartedAt ||
        Date.now(),
      provider,
      model,
      estimated: analysis.total,
    });
  }

  logTitleBox(
    `CLAUDEZEN REQUEST #${n}`,
  );

  logSectionTitle("📦 CONTEXTO");

  logRow(
    "Payload",
    formatBytes(
      analysis.payloadBytes,
    ),
  );

  logRow(
    "Tokens estimados",
    `~${formatNumber(
      analysis.total,
    )}`,
  );

  console.log("");

  logRow(
    "System",
    `~${formatNumber(
      analysis.systemTokens,
    )} tokens`,
  );

  logRow(
    "Messages",
    `~${formatNumber(
      analysis.messagesTokens,
    )} tokens`,
  );

  logRow(
    "Tools",
    `~${formatNumber(
      analysis.toolsTokens,
    )} tokens`,
  );

  logRow(
    "Other",
    `~${formatNumber(
      analysis.otherTokens,
    )} tokens`,
  );

  logSectionTitle("🧰 TOOLS");

  logRow(
    "Quantidade",
    analysis.toolCount,
  );

  if (analysis.biggestTool) {
    logRow(
      "Maior",
      `${analysis.biggestTool.name} → ~${formatNumber(
        analysis.biggestTool.tokens,
      )} tokens`,
    );
  }

  logSectionTitle("🚦 ROTEAMENTO");

  logRow("Modo", mode);
  logRow("Motivo", reason);
  logRow("Provider", provider);
  logRow("Modelo", model);

  const fallbackCount =
    Number(
      routed?.fallbackCount || 0,
    );

  const skipped =
    Array.isArray(routed?.skipped)
      ? routed.skipped
      : [];

  if (fallbackCount > 0) {
    OBSERVABILITY_SESSION.fallbacks += 1;

    logRow(
      "Fallback",
      `SIM (${fallbackCount} provider(s) falharam antes)`,
    );
  }

  if (skipped.length > 0) {
    logRow(
      "Pulados (cooldown)",
      skipped.join(", "),
    );
  }

  logSectionTitle("🌐 REQUISIÇÃO");

  logRow(
    "Endpoint",
    requestLabel(req),
  );

  logRow(
    "Horário",
    new Date().toLocaleTimeString(),
  );
}

function logUsage(
  usage,
  source = "upstream",
  res = null,
) {
  if (
    !usage ||
    typeof usage !== "object"
  ) {
    return;
  }

  const input =
    Number(
      usage.input_tokens || 0,
    );

  const output =
    Number(
      usage.output_tokens || 0,
    );

  const total =
    input + output;

  OBSERVABILITY_SESSION.actualInputTokens +=
    input;

  OBSERVABILITY_SESSION.actualOutputTokens +=
    output;

  OBSERVABILITY_SESSION.actualTotalTokens +=
    total;

  const obs = res
    ? REQUEST_OBS.get(res)
    : null;

  /*
   * Em stream o usage só chega no fim; o router
   * contabiliza uma vez aqui. Respostas não-stream
   * já são contabilizadas dentro do próprio router.
   */
  if (
    source === "upstream-stream" &&
    typeof ROUTER.recordUsage ===
      "function"
  ) {
    ROUTER.recordUsage(usage);
  }

  logSectionTitle(
    obs
      ? `📊 USAGE — REQUEST #${obs.n}`
      : "📊 USAGE",
  );

  logRow(
    "Input",
    `${formatNumber(input)} tokens (upstream)`,
  );

  logRow(
    "Output",
    `${formatNumber(output)} tokens (upstream)`,
  );

  logRow(
    "Total",
    `${formatNumber(total)} tokens (upstream)`,
  );

  if (obs && input > 0) {
    const diff =
      input - obs.estimated;

    console.log("");

    logRow(
      "Estimativa local",
      `~${formatNumber(
        obs.estimated,
      )} tokens`,
    );

    logRow(
      "Diferença input",
      `${diff >= 0 ? "+" : "−"}${formatNumber(
        Math.abs(diff),
      )} tokens`,
    );
  }

  logHttpResult(res);

  console.log("");
  console.log(LOG_BAR);

  if (total > 0) {
    console.log(
      "   ✓ USAGE CONFIRMADO PELO UPSTREAM",
    );

    console.log(
      `     Input + Output = ${formatNumber(
        total,
      )} tokens`,
    );
  } else {
    console.log(
      "   Upstream não informou usage nesta resposta",
    );
  }

  console.log(LOG_BAR);
}

/*
 * Usado nas rotas passthrough (ex.: /v1/chat/completions),
 * onde o corpo é repassado sem parse e não há usage.
 */
function logPassthroughDone(res) {
  logHttpResult(res);

  console.log("");
  console.log(LOG_BAR);

  console.log(
    "   Resposta repassada sem leitura de usage (passthrough)",
  );

  console.log(LOG_BAR);
}

function logSessionUsage() {
  logSectionTitle("📈 SESSÃO");

  logRow(
    "Requests",
    OBSERVABILITY_SESSION.requests,
  );

  logRow(
    "Estimado acumulado",
    `~${formatNumber(
      OBSERVABILITY_SESSION.estimatedInputTokens,
    )} tokens`,
  );

  logRow(
    "Input (upstream)",
    `${formatNumber(
      OBSERVABILITY_SESSION.actualInputTokens,
    )} tokens`,
  );

  logRow(
    "Output (upstream)",
    `${formatNumber(
      OBSERVABILITY_SESSION.actualOutputTokens,
    )} tokens`,
  );

  logRow(
    "Total (upstream)",
    `${formatNumber(
      OBSERVABILITY_SESSION.actualTotalTokens,
    )} tokens`,
  );

  logRow(
    "Fallbacks",
    OBSERVABILITY_SESSION.fallbacks,
  );

  logRow(
    "Erros",
    OBSERVABILITY_SESSION.errors,
  );

  console.log("");
}

function logShutdown(reason) {
  console.log("");

  console.log(
    `[${new Date().toLocaleTimeString()}] ⏹️  ${reason} — salvando cache de reasoning e encerrando...`,
  );

  if (OBSERVABILITY_SESSION.requests > 0) {
    logSessionUsage();
  }
}

function printStartupBanner() {
  const routing =
    CONFIG.routing || {};

  const providers =
    CONFIG.providers || {};

  let routerStatus = null;

  try {
    routerStatus =
      ROUTER.status();
  } catch {
    routerStatus = null;
  }

  const mode = String(
    routerStatus?.mode ||
      routing.mode ||
      "auto",
  ).toUpperCase();

  logTitleBox("CLAUDEZEN BRIDGE");

  console.log("");

  logRow("Status", "✓ Online");

  logRow(
    "Endereço",
    `http://${CONFIG.listenHost}:${CONFIG.port}`,
  );

  logRow(
    "Admin",
    `http://127.0.0.1:${CONFIG.port}/admin?token=${ADMIN_TOKEN}`,
  );

  logRow("Config", CONFIG.configPath);

  logRow(
    "Modo",
    mode === "MANUAL" &&
      routerStatus?.manualProvider
      ? `${mode} (${routerStatus.manualProvider})`
      : mode,
  );

  logRow(
    "Limite contexto",
    `${formatNumber(
      routerStatus?.thresholdTokens ??
        routing.largeContextThreshold,
    )} tokens`,
  );

  if (CONFIG.maxOutputTokens > 0) {
    logRow(
      "Limite de saída",
      `${formatNumber(
        CONFIG.maxOutputTokens,
      )} tokens (max_tokens)`,
    );
  }

  logSectionTitle("🚦 PROVIDERS");

  const ids =
    Object.keys(providers);

  if (ids.length === 0) {
    console.log(
      "   ⚠️  Nenhum provider configurado em config.json",
    );
  }

  for (const id of ids) {
    const provider =
      providers[id] || {};

    const keyInfo =
      getKeyInfoForProvider(provider, id);

    const hasKey = keyInfo.hasKey;

    const roles = [];

    const effectiveNormal =
      routerStatus?.normalProvider ||
      routing.normalProvider;

    const effectiveLarge =
      routerStatus?.largeContextProvider ||
      routing.largeContextProvider;

    if (id === effectiveNormal) {
      roles.push("normal");
    }

    if (id === effectiveLarge) {
      roles.push("contexto grande");
    }

    if (roles.length === 0) {
      roles.push("reserva");
    }

    let origemChave;

    if (keyInfo.keySource === "stored") {
      origemChave = `armazenada localmente (...${keyInfo.keyLast4 || "????"})`;
    } else if (keyInfo.keySource === "env") {
      origemChave = `variável ${provider.apiKeyEnv} (...${keyInfo.keyLast4 || "????"})`;
    } else {
      origemChave = "ausente";
    }

    console.log(
      `   ${hasKey ? "●" : "○"} ${String(
        provider.name || id,
      ).padEnd(12)} ${
        provider.model || "?"
      }  [${roles.join(" + ")}]`,
    );

    console.log(
      `       chave: ${origemChave}`,
    );

    if (!hasKey) {
      console.log(
        `       ⚠️  defina a variável ${
          provider.apiKeyEnv ||
          "(apiKeyEnv não configurada)"
        } ou adicione pela API administrativa`,
      );
    }
  }

  const order = (
    routerStatus?.fallbackOrder ||
    routing.fallbackOrder ||
    []
  )
    .map(
      (id) =>
        providers[id]?.name || id,
    )
    .join(" → ");

  if (order) {
    console.log("");
    logRow("Fallback", order);
  }

  console.log("");

  console.log(
    "   Aguardando requisições...  (Ctrl+C para encerrar)",
  );

  console.log(LOG_BAR);
  console.log("");
}

/* ============================================================
   UPSTREAM
   ============================================================ */

function upstreamResponseHeaders(
  headers,
) {
  const out = {
    "access-control-allow-origin":
      "*",
  };

  for (
    const name of CHAT_COMPLETIONS_RESPONSE_HEADERS
  ) {
    const value =
      headers.get(name);

    if (value) {
      out[name] = value;
    }
  }

  return out;
}

function openAiUsageToAnthropic(
  usage,
) {
  if (
    !usage ||
    typeof usage !== "object"
  ) {
    return {
      input_tokens: 0,
      output_tokens: 0,
    };
  }

  const out = {
    input_tokens:
      usage.prompt_tokens ||
      usage.input_tokens ||
      0,

    output_tokens:
      usage.completion_tokens ||
      usage.output_tokens ||
      0,
  };

  if (
    usage.prompt_cache_hit_tokens
  ) {
    out.cache_read_input_tokens =
      usage.prompt_cache_hit_tokens;
  }

  if (
    usage.prompt_cache_miss_tokens
  ) {
    out.cache_creation_input_tokens =
      usage.prompt_cache_miss_tokens;
  }

  return out;
}

function createUpstreamContext(
  res,
) {
  const controller =
    new AbortController();

  let abortStatus = 504;

  let abortMessage =
    `Upstream request timed out after ${CONFIG.upstreamTimeoutMs}ms`;

  let timer = null;

  function abort(
    message,
    status,
  ) {
    if (
      controller.signal.aborted
    ) {
      return;
    }

    abortMessage = message;
    abortStatus = status;

    controller.abort();
  }

  if (
    CONFIG.upstreamTimeoutMs > 0
  ) {
    timer = setTimeout(
      () =>
        abort(
          `Upstream request timed out after ${CONFIG.upstreamTimeoutMs}ms`,
          504,
        ),
      CONFIG.upstreamTimeoutMs,
    );
  }

  const onClose = () => {
    if (!res.writableEnded) {
      abort(
        "Client disconnected before upstream response completed",
        499,
      );
    }
  };

  res.on("close", onClose);

  return {
    signal:
      controller.signal,

    get abortStatus() {
      return abortStatus;
    },

    get abortMessage() {
      return abortMessage;
    },

    cleanup() {
      if (timer) {
        clearTimeout(timer);
      }

      res.off(
        "close",
        onClose,
      );
    },
  };
}

async function probeUpstream(req) {
  const upstreamApiKey =
    requestAuthToken(req);

  if (!upstreamApiKey) {
    const error = new Error(
      "OpenCode Go API key is required for upstream health probe.",
    );

    error.status = 400;
    error.type =
      "invalid_request_error";

    throw error;
  }

  const controller =
    new AbortController();

  const timer =
    CONFIG.upstreamTimeoutMs > 0
      ? setTimeout(
          () =>
            controller.abort(),
          Math.min(
            CONFIG.upstreamTimeoutMs,
            15000,
          ),
        )
      : null;

  try {
    const response = await fetch(
      `${CONFIG.upstreamBaseUrl}/models`,
      {
        method: "GET",

        headers: {
          authorization:
            `Bearer ${upstreamApiKey}`,
        },

        signal:
          controller.signal,
      },
    );

    return {
      ok: response.ok,
      status: response.status,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError =
        new Error(
          "Upstream health probe timed out.",
        );

      timeoutError.status = 504;
      timeoutError.type =
        "proxy_error";

      throw timeoutError;
    }

    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/* ============================================================
   STREAMING
   ============================================================ */

async function streamOpenAiAsAnthropic(
  upstream,
  res,
  model,
  toolContextParts = [],
  upstreamContext = null,
) {
  res.writeHead(200, {
    "content-type":
      "text/event-stream; charset=utf-8",

    "cache-control":
      "no-cache",

    connection: "keep-alive",
  });

  writeMessageStart(
    res,
    model,
  );

  const decoder =
    new TextDecoder();

  let buffer = "";

  let thinkingBlockIndex = null;
  let thinkingBlockStopped = false;

  let textBlockIndex = null;
  let nextBlockIndex = 0;

  let stopReason = "end_turn";

  const toolBlocks = new Map();

  let reasoningContent = "";
  let textContent = "";

  let usage = {
    input_tokens: 0,
    output_tokens: 0,
  };

  let streamInterrupted = false;

  function ensureThinkingBlock() {
    if (
      thinkingBlockIndex !== null
    ) {
      return thinkingBlockIndex;
    }

    thinkingBlockIndex =
      nextBlockIndex++;

    contentBlockStart(
      res,
      thinkingBlockIndex,
      {
        type: "thinking",
        thinking: "",
        signature: "",
      },
    );

    return thinkingBlockIndex;
  }

  function stopThinkingBlockIfOpen() {
    if (
      thinkingBlockIndex === null ||
      thinkingBlockStopped
    ) {
      return;
    }

    contentBlockDelta(
      res,
      thinkingBlockIndex,
      {
        type: "signature_delta",
        signature: "",
      },
    );

    contentBlockStop(
      res,
      thinkingBlockIndex,
    );

    thinkingBlockStopped = true;
  }

  function ensureTextBlock() {
    stopThinkingBlockIfOpen();

    if (
      textBlockIndex !== null
    ) {
      return textBlockIndex;
    }

    textBlockIndex =
      nextBlockIndex++;

    contentBlockStart(
      res,
      textBlockIndex,
      {
        type: "text",
        text: "",
      },
    );

    return textBlockIndex;
  }

  function ensureToolBlock(
    callIndex,
    chunk,
  ) {
    stopThinkingBlockIfOpen();

    if (
      toolBlocks.has(callIndex)
    ) {
      return toolBlocks.get(
        callIndex,
      );
    }

    const blockIndex =
      nextBlockIndex++;

    const id =
      chunk.id ||
      `call_${callIndex}_${Date.now().toString(36)}`;

    const name =
      (chunk.function &&
        chunk.function.name) ||
      `tool_${callIndex}`;

    contentBlockStart(
      res,
      blockIndex,
      {
        type: "tool_use",
        id,
        name,
        input: {},
      },
    );

    const state = {
      blockIndex,
      id,
      name,
    };

    toolBlocks.set(
      callIndex,
      state,
    );

    return state;
  }

  function handleChunk(obj) {
    const choice =
      obj.choices &&
      obj.choices[0];

    if (obj.usage) {
      usage =
        openAiUsageToAnthropic(
          obj.usage,
        );

      if (
        process.env
          .CLAUDE_OPENCODE_LOG_USAGE
      ) {
        console.error(
          `usage raw=${JSON.stringify(
            obj.usage,
          )} translated=${JSON.stringify(
            usage,
          )}`,
        );
      }
    }

    if (!choice) return;

    const delta =
      choice.delta || {};

    if (delta.content) {
      textContent +=
        delta.content;

      contentBlockDelta(
        res,
        ensureTextBlock(),
        {
          type: "text_delta",
          text: delta.content,
        },
      );
    }

    const reasoningDelta =
      reasoningFromMessage(
        delta,
      );

    if (reasoningDelta) {
      reasoningContent +=
        reasoningDelta;

      if (
        !thinkingBlockStopped
      ) {
        contentBlockDelta(
          res,
          ensureThinkingBlock(),
          {
            type: "thinking_delta",
            thinking:
              reasoningDelta,
          },
        );
      }
    }

    for (
      const call of
      delta.tool_calls || []
    ) {
      const callIndex =
        call.index || 0;

      const state =
        ensureToolBlock(
          callIndex,
          call,
        );

      const args =
        call.function &&
        call.function.arguments;

      if (args) {
        contentBlockDelta(
          res,
          state.blockIndex,
          {
            type:
              "input_json_delta",
            partial_json: args,
          },
        );
      }
    }

    if (
      choice.finish_reason
    ) {
      stopReason =
        mapFinishReason(
          choice.finish_reason,
        );
    }
  }

  try {
    for await (
      const chunk of upstream.body
    ) {
      buffer += decoder.decode(
        chunk,
        {
          stream: true,
        },
      );

      const parts =
        buffer.split(
          /\r?\n\r?\n/,
        );

      buffer =
        parts.pop() || "";

      for (const part of parts) {
        const dataLines =
          part
            .split(/\r?\n/)
            .filter((line) =>
              line.startsWith(
                "data:",
              ),
            )
            .map((line) =>
              line
                .slice(5)
                .trim(),
            );

        if (!dataLines.length) {
          continue;
        }

        const data =
          dataLines.join(
            "\n",
          );

        if (
          data === "[DONE]"
        ) {
          continue;
        }

        try {
          handleChunk(
            JSON.parse(data),
          );
        } catch (error) {
          console.error(
            `Failed to parse upstream SSE chunk: ${error.message}; data=${truncateForLog(
              data,
            )}`,
          );
        }
      }
    }
  } catch (error) {
    console.error(
      `[${new Date().toLocaleTimeString()}] ✗ Stream com o upstream interrompido: ${error.message}`,
    );

    streamInterrupted = true;
    stopReason = "end_turn";
  } finally {
    stopThinkingBlockIfOpen();

    if (streamInterrupted) {
      contentBlockDelta(
        res,
        ensureTextBlock(),
        {
          type: "text_delta",
          text:
            "\n\n[stream interrupted]",
        },
      );
    }

    if (
      textBlockIndex !== null
    ) {
      contentBlockStop(
        res,
        textBlockIndex,
      );
    }

    if (
      textContent &&
      reasoningContent
    ) {
      setAssistantReasoning(
        textContent,
        reasoningContent,
      );

      setToolContextReasoning(
        toolContextParts,
        textContent,
        reasoningContent,
      );
    }

    for (
      const state of
      toolBlocks.values()
    ) {
      if (reasoningContent) {
        setToolReasoning(
          state.id,
          reasoningContent,
        );
      }

      contentBlockStop(
        res,
        state.blockIndex,
      );
    }

    sse(
      res,
      "message_delta",
      {
        type: "message_delta",

        delta: {
          stop_reason:
            stopReason,
          stop_sequence: null,
        },

        usage,
      },
    );

    sse(
      res,
      "message_stop",
      {
        type: "message_stop",
      },
    );

    logUsage(
      usage,
      "upstream-stream",
      res,
    );

    logSessionUsage();

    if (
      !res.writableEnded &&
      !res.destroyed
    ) {
      res.end();
    }

    if (upstreamContext) {
      upstreamContext.cleanup();
    }
  }
}

/* ============================================================
   /v1/messages
   ============================================================ */

async function handleMessages(
  req,
  res,
) {
  const body =
    await readJsonBody(req);

  const wantsStream =
    body.stream === true;

  const toolContextParts =
    currentToolContextParts(
      body.messages,
    );

  const payload =
    anthropicToOpenAi(
      body,
      wantsStream,
    );

  const upstreamContext =
    createUpstreamContext(res);

  let upstream;
  let routed;

  try {
    routed =
      await callOpenCode(
        req,
        payload,
        upstreamContext,
      );

    upstream =
      routed.response;

    /*
     * Router já calculou:
     * - contexto
     * - tokens estimados
     * - tools
     * - provider
     * - model
     * - motivo da rota
     * - fallback
     *
     * Server apenas apresenta.
     */
    logObservabilityStart(
      req,
      payload,
      routed,
      res,
    );

    if (wantsStream) {
      await streamOpenAiAsAnthropic(
        upstream,
        res,
        body.model,
        toolContextParts,
        upstreamContext,
      );

      return;
    }

    const openAiBody =
      await upstream.json();

    openAiBody.model =
      body.model;

    const anthropicBody =
      openAiToAnthropic(
        openAiBody,
        body.model,
        toolContextParts,
      );

    logUsage(
      anthropicBody.usage,
      "upstream",
      res,
    );

    logSessionUsage();

    sendJson(
      res,
      200,
      anthropicBody,
    );
  } catch (error) {
    throw normalizeUpstreamError(
      error,
      upstreamContext,
    );
  } finally {
    upstreamContext.cleanup();
  }
}

/* ============================================================
   /v1/chat/completions
   ============================================================ */

async function handleChatCompletions(
  req,
  res,
) {
  const body =
    await readJsonBody(req);

  const upstreamContext =
    createUpstreamContext(res);

  let routed;
  let upstream;

  try {
    routed =
      await callOpenCode(
        req,
        body,
        upstreamContext,
      );

    upstream =
      routed.response;

    logObservabilityStart(
      req,
      body,
      routed,
      res,
    );

    res.writeHead(
      upstream.status,
      upstreamResponseHeaders(
        upstream.headers,
      ),
    );

    if (upstream.body) {
      for await (
        const chunk of upstream.body
      ) {
        res.write(chunk);
      }
    }

    res.end();

    logPassthroughDone(res);

    logSessionUsage();
  } catch (error) {
    throw normalizeUpstreamError(
      error,
      upstreamContext,
    );
  } finally {
    upstreamContext.cleanup();
  }
}

/* ============================================================
   ADMIN — CONFIG PERSISTÊNCIA E RELOAD
   ============================================================ */

function getRawConfig() {
  return readJson(CONFIG.configPath) || {};
}

function writeConfigAtomic(rawConfig) {
  const tmp =
    CONFIG.configPath + ".tmp." + process.pid;

  fs.writeFileSync(
    tmp,
    JSON.stringify(rawConfig, null, 2),
    "utf8",
  );

  fs.renameSync(tmp, CONFIG.configPath);
}

function backupConfig() {
  const backupsDir = path.join(
    path.dirname(CONFIG.configPath),
    ".claudezen-backups",
  );

  try {
    fs.mkdirSync(backupsDir, { recursive: true });
  } catch {
    /* ignore */
  }

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-");

  const backupPath = path.join(
    backupsDir,
    `config-${stamp}.json`,
  );

  try {
    fs.copyFileSync(CONFIG.configPath, backupPath);
  } catch {
    /* ignore */
  }

  try {
    const files = fs
      .readdirSync(backupsDir)
      .filter(
        (f) =>
          f.startsWith("config-") &&
          f.endsWith(".json"),
      )
      .sort();

    while (files.length > 10) {
      const oldest = files.shift();
      try {
        fs.unlinkSync(
          path.join(backupsDir, oldest),
        );
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

function reloadConfig() {
  const oldStats =
    ROUTER && typeof ROUTER.getStats === "function"
      ? ROUTER.getStats()
      : null;

  const newConfig = loadConfig();

  CONFIG = newConfig;

  ROUTER = createRouter(CONFIG, {
    secrets: secretsStore,
    stats: oldStats,
  });

  return CONFIG;
}

function saveConfig(rawConfig) {
  const { errors } =
    validateConfig(rawConfig);

  if (errors.length) {
    const error = new Error(
      errors.join("; "),
    );

    error.status = 422;
    error.errors = errors;

    throw error;
  }

  backupConfig();
  writeConfigAtomic(rawConfig);
  reloadConfig();
}

function generateApiKeyEnv(id) {
  const upper = String(id)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return `CLAUDEZEN_${upper}_API_KEY`;
}

function getKeyInfoForProvider(provider, id) {
  const stored = secretsStore.getSecret(id);

  if (stored) {
    return {
      hasKey: true,
      keySource: "stored",
      keyLast4:
        stored.length >= 4
          ? stored.slice(-4)
          : null,
    };
  }

  const envKey =
    provider.apiKeyEnv
      ? process.env[provider.apiKeyEnv]
      : "";

  if (envKey) {
    return {
      hasKey: true,
      keySource: "env",
      keyLast4:
        envKey.length >= 4
          ? envKey.slice(-4)
          : null,
    };
  }

  return {
    hasKey: false,
    keySource: "missing",
    keyLast4: null,
  };
}

function getRoutingStatePath() {
  return (
    CONFIG.routingStatePath ||
    path.join(
      path.dirname(CONFIG.configPath),
      "routing-state.json",
    )
  );
}

function writeRoutingState(mode, providerId) {
  const statePath = getRoutingStatePath();
  const tmp = statePath + ".tmp." + process.pid;

  fs.writeFileSync(
    tmp,
    JSON.stringify({
      mode,
      provider:
        mode === "manual" ? providerId : null,
    }),
    "utf8",
  );

  fs.renameSync(tmp, statePath);
}

/* ============================================================
   ADMIN — SEGURANÇA
   ============================================================ */

function isAllowedHost(hostHeader, actualPort) {
  const port = actualPort;
  const allowed = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `127.0.0.1`,
    `localhost`,
  ]);

  return allowed.has(String(hostHeader || ""));
}

function isAllowedOrigin(originHeader, actualPort) {
  if (!originHeader) return true;

  const port = actualPort;
  const allowed = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ]);

  return allowed.has(String(originHeader));
}

function adminSecurityCheck(req, res, method) {
  const token = req.headers["x-admin-token"];
  const actualPort = req.socket && req.socket.localPort;

  if (!token || !safeCompare(token, ADMIN_TOKEN)) {
    sendAdminError(
      res,
      401,
      "Token administrativo ausente ou inválido.",
    );
    return false;
  }

  if (!isAllowedHost(req.headers.host, actualPort)) {
    sendAdminError(
      res,
      403,
      "Host não permitido. Acesse via 127.0.0.1 ou localhost.",
    );
    return false;
  }

  const stateChanging =
    method === "POST" ||
    method === "PUT" ||
    method === "PATCH" ||
    method === "DELETE";

  if (
    stateChanging &&
    !isAllowedOrigin(req.headers.origin, actualPort)
  ) {
    sendAdminError(
      res,
      403,
      "Origem não permitida.",
    );
    return false;
  }

  return true;
}

/* ============================================================
   ADMIN — HANDLERS
   ============================================================ */

function buildAdminState() {
  const providers = CONFIG.providers || {};
  const routing = CONFIG.routing || {};
  const routerStatus = ROUTER.status();

  const providersOut = {};

  for (const id of Object.keys(providers)) {
    const p = providers[id];
    const keyInfo = getKeyInfoForProvider(p, id);
    const stats = routerStatus.providers?.[id] || {};

    providersOut[id] = {
      id,
      name: p.name || id,
      baseUrl: p.baseUrl,
      model: p.model,
      apiKeyEnv: p.apiKeyEnv,
      timeoutMs: p.timeoutMs || null,
      headers: p.headers || null,
      ...keyInfo,
      online: stats.online !== false,
      cooldownUntil: stats.cooldownUntil || null,
      requests: stats.requests || 0,
      successes: stats.successes || 0,
      failures: stats.failures || 0,
      lastStatus: stats.lastStatus || null,
      lastError: stats.lastError || null,
    };
  }

  return {
    mode: routerStatus.mode,
    manualProvider: routerStatus.manualProvider,
    normalProvider: routerStatus.normalProvider,
    largeContextProvider:
      routerStatus.largeContextProvider,
    largeContextThreshold:
      routerStatus.thresholdTokens,
    fallbackOrder: routerStatus.fallbackOrder,
    providers: providersOut,
  };
}

async function handleAdminApi(req, res, url) {
  const method = req.method;
  const pathname = url.pathname;

  const staticFile =
    ADMIN_STATIC_FILES[pathname];

  if (method === "GET" && staticFile) {
    if (
      !isAllowedHost(
        req.headers.host,
        req.socket && req.socket.localPort,
      )
    ) {
      res.writeHead(403, {
        "content-type":
          "text/html; charset=utf-8",
      });

      res.end(
        "<h1>403 — Host não permitido.</h1>",
      );
      return;
    }

    const adminDir = path.join(
      __dirname,
      "admin",
    );

    const filePath = path.join(
      adminDir,
      staticFile,
    );

    const resolved = path.resolve(filePath);

    if (
      resolved !==
        path.join(adminDir, staticFile)
    ) {
      res.writeHead(404, {
        "content-type":
          "text/html; charset=utf-8",
      });
      res.end("<h1>404</h1>");
      return;
    }

    let content;
    try {
      content = fs.readFileSync(
        resolved,
        "utf8",
      );
    } catch {
      res.writeHead(404, {
        "content-type":
          "text/html; charset=utf-8",
      });
      res.end(
        "<h1>404 — Arquivo não encontrado.</h1>",
      );
      return;
    }

    res.writeHead(200, {
      "content-type":
        ADMIN_STATIC_TYPES[staticFile],
      "cache-control": "no-store",
      "content-security-policy":
        ADMIN_STATIC_CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });

    res.end(content);
    return;
  }

  if (!adminSecurityCheck(req, res, method)) {
    return;
  }

  try {
    /* ---- GET /admin/api/state ---- */
    if (
      method === "GET" &&
      pathname === "/admin/api/state"
    ) {
      sendAdminJson(res, 200, buildAdminState());
      return;
    }

    /* ---- POST /admin/api/providers ---- */
    if (
      method === "POST" &&
      pathname === "/admin/api/providers"
    ) {
      const body = await readAdminJsonBody(req);

      const id = body.id;

      if (
        !id ||
        typeof id !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)
      ) {
        sendAdminError(
          res,
          400,
          "ID do provider inválido. Use letras, números, '.', '_' ou '-'.",
        );
        return;
      }

      const raw = getRawConfig();
      raw.providers = raw.providers || {};

      if (raw.providers[id]) {
        sendAdminError(
          res,
          409,
          `Já existe um provider com o ID "${id}".`,
        );
        return;
      }

      if (
        !body.baseUrl ||
        !body.model
      ) {
        sendAdminError(
          res,
          400,
          "Os campos 'baseUrl' e 'model' são obrigatórios.",
        );
        return;
      }

      const provider = {
        name: body.name || id,
        baseUrl: String(body.baseUrl),
        model: String(body.model),
        apiKeyEnv:
          body.apiKeyEnv || generateApiKeyEnv(id),
      };

      if (body.timeoutMs !== undefined) {
        provider.timeoutMs = Number(body.timeoutMs);
      }

      if (
        body.headers &&
        typeof body.headers === "object"
      ) {
        provider.headers = body.headers;
      }

      raw.providers[id] = provider;

      raw.routing = raw.routing || {};
      raw.routing.fallbackOrder =
        raw.routing.fallbackOrder || [];

      if (
        !raw.routing.fallbackOrder.includes(id)
      ) {
        raw.routing.fallbackOrder.push(id);
      }

      saveConfig(raw);

      if (body.apiKey) {
        secretsStore.setSecret(id, String(body.apiKey));
      }

      sendAdminJson(res, 201, {
        id,
        message: "Provider criado com sucesso.",
      });
      return;
    }

    /* ---- PUT /admin/api/providers/:id ---- */
    const putMatch = pathname.match(
      /^\/admin\/api\/providers\/([^/]+)$/,
    );

    if (method === "PUT" && putMatch) {
      const id = decodeURIComponent(putMatch[1]);
      const body = await readAdminJsonBody(req);

      const raw = getRawConfig();
      raw.providers = raw.providers || {};

      if (!raw.providers[id]) {
        sendAdminError(
          res,
          404,
          `Provider "${id}" não encontrado.`,
        );
        return;
      }

      const current = raw.providers[id];

      if (body.name !== undefined)
        current.name = String(body.name);
      if (body.baseUrl !== undefined)
        current.baseUrl = String(body.baseUrl);
      if (body.model !== undefined)
        current.model = String(body.model);
      if (body.timeoutMs !== undefined)
        current.timeoutMs = Number(body.timeoutMs);
      if (
        body.headers !== undefined
      ) {
        current.headers =
          body.headers === null
            ? undefined
            : body.headers;
      }

      saveConfig(raw);

      if (
        body.apiKey !== undefined &&
        body.apiKey !== null &&
        body.apiKey !== ""
      ) {
        secretsStore.setSecret(id, String(body.apiKey));
      }

      sendAdminJson(res, 200, {
        id,
        message: "Provider atualizado com sucesso.",
      });
      return;
    }

    /* ---- DELETE /admin/api/providers/:id ---- */
    if (method === "DELETE" && putMatch) {
      const id = decodeURIComponent(putMatch[1]);

      const raw = getRawConfig();
      raw.providers = raw.providers || {};
      raw.routing = raw.routing || {};

      if (!raw.providers[id]) {
        sendAdminError(
          res,
          404,
          `Provider "${id}" não encontrado.`,
        );
        return;
      }

      const normal = raw.routing.normalProvider;
      const large = raw.routing.largeContextProvider;
      const state = ROUTER.getModeState();
      const manualActive =
        state.mode === "manual" && state.provider === id;

      if (
        id === normal ||
        id === large ||
        manualActive
      ) {
        const reasons = [];
        if (id === normal)
          reasons.push("normalProvider");
        if (id === large)
          reasons.push("largeContextProvider");
        if (manualActive)
          reasons.push("provider manual ativo");

        sendAdminError(
          res,
          409,
          `Não é possível remover "${id}". Ele está em uso como: ${reasons.join(", ")}. Altere essas configurações antes de remover.`,
        );
        return;
      }

      delete raw.providers[id];

      if (Array.isArray(raw.routing.fallbackOrder)) {
        raw.routing.fallbackOrder =
          raw.routing.fallbackOrder.filter(
            (x) => x !== id,
          );
      }

      saveConfig(raw);
      secretsStore.deleteSecret(id);

      sendAdminJson(res, 200, {
        id,
        message: "Provider removido com sucesso.",
      });
      return;
    }

    /* ---- PUT /admin/api/key/:id ---- */
    const keyMatch = pathname.match(
      /^\/admin\/api\/key\/([^/]+)$/,
    );

    if (method === "PUT" && keyMatch) {
      const id = decodeURIComponent(keyMatch[1]);
      const body = await readAdminJsonBody(req);

      if (
        !body.apiKey ||
        typeof body.apiKey !== "string"
      ) {
        sendAdminError(
          res,
          400,
          "O campo 'apiKey' é obrigatório.",
        );
        return;
      }

      if (!CONFIG.providers?.[id]) {
        sendAdminError(
          res,
          404,
          `Provider "${id}" não encontrado.`,
        );
        return;
      }

      secretsStore.setSecret(id, body.apiKey);

      sendAdminJson(res, 200, {
        id,
        message: "Chave atualizada com sucesso.",
      });
      return;
    }

    /* ---- DELETE /admin/api/key/:id ---- */
    if (method === "DELETE" && keyMatch) {
      const id = decodeURIComponent(keyMatch[1]);

      if (!CONFIG.providers?.[id]) {
        sendAdminError(
          res,
          404,
          `Provider "${id}" não encontrado.`,
        );
        return;
      }

      secretsStore.deleteSecret(id);

      sendAdminJson(res, 200, {
        id,
        message:
          "Chave removida do armazenamento local. A variável de ambiente volta a valer, se existir.",
      });
      return;
    }

    /* ---- PUT /admin/api/order ---- */
    if (
      method === "PUT" &&
      pathname === "/admin/api/order"
    ) {
      const body = await readAdminJsonBody(req);
      const order = body.fallbackOrder;

      if (
        !Array.isArray(order) ||
        order.length === 0
      ) {
        sendAdminError(
          res,
          400,
          "'fallbackOrder' deve ser uma lista não vazia de IDs.",
        );
        return;
      }

      const raw = getRawConfig();
      raw.routing = raw.routing || {};
      raw.providers = raw.providers || {};

      const seen = new Set();

      for (const id of order) {
        if (!raw.providers[id]) {
          sendAdminError(
            res,
            400,
            `O ID "${id}" não corresponde a um provider existente.`,
          );
          return;
        }
        if (seen.has(id)) {
          sendAdminError(
            res,
            400,
            `O ID "${id}" aparece mais de uma vez na lista.`,
          );
          return;
        }
        seen.add(id);
      }

      raw.routing.fallbackOrder = order;
      saveConfig(raw);

      sendAdminJson(res, 200, {
        fallbackOrder: order,
        message: "Ordem de fallback atualizada.",
      });
      return;
    }

    /* ---- PUT /admin/api/routing ---- */
    if (
      method === "PUT" &&
      pathname === "/admin/api/routing"
    ) {
      const body = await readAdminJsonBody(req);
      const raw = getRawConfig();
      raw.routing = raw.routing || {};
      raw.providers = raw.providers || {};

      if (body.normalProvider !== undefined) {
        if (
          body.normalProvider &&
          !raw.providers[body.normalProvider]
        ) {
          sendAdminError(
            res,
            400,
            `normalProvider "${body.normalProvider}" não existe.`,
          );
          return;
        }
        raw.routing.normalProvider =
          body.normalProvider || undefined;
      }

      if (
        body.largeContextProvider !== undefined
      ) {
        if (
          body.largeContextProvider &&
          !raw.providers[body.largeContextProvider]
        ) {
          sendAdminError(
            res,
            400,
            `largeContextProvider "${body.largeContextProvider}" não existe.`,
          );
          return;
        }
        raw.routing.largeContextProvider =
          body.largeContextProvider || undefined;
      }

      if (
        body.largeContextThreshold !== undefined
      ) {
        const t = Number(body.largeContextThreshold);
        if (!Number.isFinite(t) || t < 1) {
          sendAdminError(
            res,
            400,
            "largeContextThreshold deve ser um número >= 1.",
          );
          return;
        }
        raw.routing.largeContextThreshold = t;
      }

      saveConfig(raw);

      sendAdminJson(res, 200, {
        normalProvider: raw.routing.normalProvider,
        largeContextProvider:
          raw.routing.largeContextProvider,
        largeContextThreshold:
          raw.routing.largeContextThreshold,
        message: "Configuração de roteamento atualizada.",
      });
      return;
    }

    /* ---- PUT /admin/api/mode ---- */
    if (
      method === "PUT" &&
      pathname === "/admin/api/mode"
    ) {
      const body = await readAdminJsonBody(req);
      const mode = String(body.mode || "").toLowerCase();

      if (mode !== "auto" && mode !== "manual") {
        sendAdminError(
          res,
          400,
          "'mode' deve ser 'auto' ou 'manual'.",
        );
        return;
      }

      let providerId = null;

      if (mode === "manual") {
        providerId = body.provider;
        if (
          !providerId ||
          !CONFIG.providers?.[providerId]
        ) {
          sendAdminError(
            res,
            400,
            "Modo manual requer um 'provider' válido.",
          );
          return;
        }
      }

      writeRoutingState(mode, providerId);

      sendAdminJson(res, 200, {
        mode,
        provider: providerId,
        message: `Modo alterado para ${mode.toUpperCase()}.`,
      });
      return;
    }

    /* ---- POST /admin/api/providers/:id/test ---- */
    const testMatch = pathname.match(
      /^\/admin\/api\/providers\/([^/]+)\/test$/,
    );

    if (method === "POST" && testMatch) {
      const id = decodeURIComponent(testMatch[1]);

      if (!CONFIG.providers?.[id]) {
        sendAdminError(
          res,
          404,
          `Provider "${id}" não encontrado.`,
        );
        return;
      }

      const result = await ROUTER.testProvider(id);

      sendAdminJson(res, 200, result);
      return;
    }

    /* ---- POST /admin/api/reload ---- */
    if (
      method === "POST" &&
      pathname === "/admin/api/reload"
    ) {
      const reloaded = reloadConfig();

      sendAdminJson(res, 200, {
        message: "Configuração recarregada com sucesso.",
        providers: Object.keys(
          reloaded.providers || {},
        ),
      });
      return;
    }

    sendAdminError(
      res,
      404,
      `Rota admin não encontrada: ${method} ${pathname}`,
    );
  } catch (error) {
    const status =
      error.status &&
      Number.isInteger(error.status)
        ? error.status
        : 500;

    sendAdminError(
      res,
      status,
      error && error.message
        ? error.message
        : String(error),
    );
  }
}

/* ============================================================
   SERVER
   ============================================================ */

function createServer() {
  const server =
    http.createServer(
      async (req, res) => {
        const startedAt =
          Date.now();

        res.claudezenStartedAt =
          startedAt;

        res.on(
          "finish",
          () =>
            logRequest(
              req,
              res,
              startedAt,
            ),
        );

        try {
          if (
            req.method ===
            "OPTIONS"
          ) {
            res.writeHead(204, {
              "access-control-allow-origin":
                "*",

              "access-control-allow-methods":
                "GET,POST,OPTIONS",

              "access-control-allow-headers":
                "*",
            });

            res.end();

            return;
          }

          const url = new URL(
            req.url,
            `http://${
              req.headers.host ||
              "localhost"
            }`,
          );

          /* ---------------------------------------------
             ROUTER STATUS
             --------------------------------------------- */

          if (
            req.method === "GET" &&
            url.pathname ===
              "/router/status"
          ) {
            sendJson(
              res,
              200,
              ROUTER.status(),
            );

            return;
          }

          /* ---------------------------------------------
             HEALTH
             --------------------------------------------- */

          if (
            req.method === "GET" &&
            url.pathname ===
              "/health"
          ) {
            const body = {
              ok: true,

              config:
                CONFIG.configPath,

              listen:
                `http://${CONFIG.listenHost}:${CONFIG.port}`,

              router:
                ROUTER.status(),
            };

            sendJson(
              res,
              200,
              body,
            );

            return;
          }

          /* ---------------------------------------------
             SHUTDOWN
             --------------------------------------------- */

          if (
            req.method === "POST" &&
            url.pathname ===
              "/shutdown"
          ) {
            if (
              !isLoopbackAddress(
                req.socket.remoteAddress,
              )
            ) {
              sendError(
                res,
                403,
                "Shutdown is only allowed from a local loopback client.",
                "forbidden_error",
              );

              return;
            }

            sendJson(
              res,
              200,
              {
                ok: true,
                shutting_down: true,
              },
            );

            requestProcessShutdown(
              server,
            );

            return;
          }

          /* ---------------------------------------------
             MODELS
             --------------------------------------------- */

          if (
            req.method === "GET" &&
            url.pathname ===
              "/v1/models"
          ) {
            sendJson(
              res,
              200,
              {
                object: "list",

                data:
                  CONFIG.models.map(
                    (id) => ({
                      id,
                      object: "model",
                      owned_by:
                        "claudezen",
                    }),
                  ),
              },
            );

            return;
          }

          /* ---------------------------------------------
             ANTHROPIC MESSAGES
             --------------------------------------------- */

          if (
            req.method === "POST" &&
            url.pathname ===
              "/v1/messages"
          ) {
            await handleMessages(
              req,
              res,
            );

            return;
          }

          /* ---------------------------------------------
             OPENAI CHAT COMPLETIONS
             --------------------------------------------- */

          if (
            req.method === "POST" &&
            url.pathname ===
              "/v1/chat/completions"
          ) {
            await handleChatCompletions(
              req,
              res,
            );

            return;
          }

          /* ---------------------------------------------
             ADMIN API
             --------------------------------------------- */

          if (
            Object.prototype.hasOwnProperty.call(
              ADMIN_STATIC_FILES,
              url.pathname,
            ) ||
            url.pathname.startsWith(
              "/admin/api/",
            )
          ) {
            await handleAdminApi(
              req,
              res,
              url,
            );

            return;
          }

          /* ---------------------------------------------
             NOT FOUND
             --------------------------------------------- */

          sendError(
            res,
            404,
            `No route for ${req.method} ${url.pathname}`,
            "not_found_error",
          );
        } catch (error) {
          const status =
            error.status &&
            Number.isInteger(
              error.status,
            )
              ? error.status
              : 500;

          const type =
            error.type ||
            (status >= 500
              ? "proxy_error"
              : "invalid_request_error");

          logRequestError(
            req,
            status,
            error,
            res,
          );

          if (
            !res.headersSent &&
            !res.destroyed
          ) {
            sendError(
              res,
              status,
              error &&
              error.message
                ? error.message
                : String(error),
              type,
            );
          } else if (
            !res.writableEnded &&
            !res.destroyed
          ) {
            res.end();
          }
        }
      },
    );

  return server;
}

/* ============================================================
   SHUTDOWN
   ============================================================ */

function installShutdownHandlers(
  server,
) {
  let shuttingDown = false;

  const shutdown = (
    signal,
  ) => {
    if (shuttingDown) return;

    shuttingDown = true;

    logShutdown(
      signal === "SIGINT"
        ? "Ctrl+C recebido"
        : `${signal} recebido`,
    );

    flushReasoningCache();

    server.close(() => {
      console.log(
        "👋 ClaudeZen encerrado.",
      );

      process.exit(0);
    });

    setTimeout(
      () => process.exit(0),
      5000,
    ).unref();
  };

  process.on(
    "SIGINT",
    () => shutdown("SIGINT"),
  );

  process.on(
    "SIGTERM",
    () => shutdown("SIGTERM"),
  );

  process.on(
    "beforeExit",
    flushReasoningCache,
  );
}

/* ============================================================
   START
   ============================================================ */

function assertConfigValid(config) {
  const { errors, warnings } =
    validateConfig(config);

  for (const warning of warnings) {
    console.warn(
      `[config] ⚠️  ${warning}`,
    );
  }

  if (errors.length) {
    console.error(
      "[config] ❌ A configuração possui erros e não pode iniciar:",
    );

    for (const error of errors) {
      console.error(`   - ${error}`);
    }

    console.error(
      "[config] Corrija o config.json e execute novamente.",
    );

    process.exit(1);
  }
}

function startServer() {
  assertConfigValid(CONFIG);

  loadReasoningCache();

  const server =
    createServer();

  installShutdownHandlers(
    server,
  );

  server.listen(
    CONFIG.port,
    CONFIG.listenHost,
    () => {
      printStartupBanner();
    },
  );

  return server;
}

if (require.main === module) {
  startServer();
}

/* ============================================================
   EXPORTS
   ============================================================ */

module.exports = {
  anthropicMessagesToOpenAi,
  anthropicToolsToOpenAi,
  anthropicToOpenAi,
  assertConfigValid,
  createServer,
  currentToolContextParts,
  expandHome,
  flushReasoningCache,
  getAdminToken: () => ADMIN_TOKEN,
  getConfig: () => CONFIG,
  getRouter: () => ROUTER,
  getToolReasoning,
  loadReasoningCache,
  mapFinishReason,
  normalizeBaseUrl,
  openAiToAnthropic,
  reasoningFromMessage,
  reloadConfig,
  requestAuthToken,
  saveReasoningCacheNow,
  setToolReasoning,
  startServer,
  streamOpenAiAsAnthropic,
  upstreamResponseHeaders,
};