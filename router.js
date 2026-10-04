const fs = require("fs");
const path = require("path");

function isRetryableStatus(status) {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  );
}

function isRetryableError(error) {
  if (!error) return true;

  if (error.status && isRetryableStatus(error.status)) {
    return true;
  }

  const retryableNames = [
    "AbortError",
    "TimeoutError",
  ];

  const retryableCodes = [
    "ECONNRESET",
    "ECONNREFUSED",
    "ECONNABORTED",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
  ];

  return (
    retryableNames.includes(error.name) ||
    retryableCodes.includes(error.code)
  );
}

function normalizeBaseUrl(url) {
  const base = String(url || "").replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

function estimateTokens(payload) {
  const json = JSON.stringify(payload || {});
  const bytes = Buffer.byteLength(json, "utf8");

  // Estimativa conservadora.
  // 1 token ≈ 4 bytes para fins de roteamento.
  return Math.ceil(bytes / 4);
}

function formatTokens(tokens) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
  }).format(tokens);
}

function nowIso() {
  return new Date().toISOString();
}

function createRouter(config) {
  const routing = config.routing || {};
  const providers = config.providers || {};

  const statePath =
    config.routingStatePath ||
    path.join(path.dirname(config.configPath), "routing-state.json");

  const cooldownMs =
    Math.max(0, Number(routing.cooldownSeconds || 300)) * 1000;

  const threshold = Math.max(
    1,
    Number(routing.largeContextThreshold || 100000),
  );

  const fallbackOrder =
    Array.isArray(routing.fallbackOrder) &&
    routing.fallbackOrder.length
      ? routing.fallbackOrder
      : ["apinex", "gemini", "openrouter"];

  const stats = new Map();

  for (const id of Object.keys(providers)) {
    stats.set(id, {
      requests: 0,
      successes: 0,
      failures: 0,
      lastStatus: null,
      lastError: null,
      lastUsedAt: null,
      cooldownUntil: 0,
    });
  }

  function providerStats(id) {
    if (!stats.has(id)) {
      stats.set(id, {
        requests: 0,
        successes: 0,
        failures: 0,
        lastStatus: null,
        lastError: null,
        lastUsedAt: null,
        cooldownUntil: 0,
      });
    }

    return stats.get(id);
  }

  function readState() {
    try {
      const state = JSON.parse(
        fs.readFileSync(statePath, "utf8"),
      );

      return state && typeof state === "object"
        ? state
        : {};
    } catch {
      return {};
    }
  }

  function getModeState() {
    const fileState = readState();

    const configuredMode =
      String(routing.mode || "auto").toLowerCase();

    const mode =
      String(fileState.mode || configuredMode).toLowerCase();

    const provider =
      fileState.provider ||
      routing.manualProvider ||
      null;

    if (mode === "manual" && providers[provider]) {
      return {
        mode: "manual",
        provider,
      };
    }

    return {
      mode: "auto",
      provider: null,
    };
  }

  function isCoolingDown(id) {
    return providerStats(id).cooldownUntil > Date.now();
  }

  function markCooldown(id, status, errorMessage) {
    const statsEntry = providerStats(id);

    statsEntry.cooldownUntil =
      Date.now() + cooldownMs;

    statsEntry.lastStatus = status || null;
    statsEntry.lastError = errorMessage || null;
  }

  function clearCooldown(id) {
    providerStats(id).cooldownUntil = 0;
  }

  function candidateOrder(contextTokens) {
    const modeState = getModeState();

    // MANUAL
    if (modeState.mode === "manual") {
      const ordered = [
        modeState.provider,
        ...fallbackOrder.filter(
          (id) => id !== modeState.provider,
        ),
      ];

      return {
        ordered,
        mode: "manual",
        reason: "MANUAL",
        selected: modeState.provider,
      };
    }

    // AUTO
    const largeProvider =
      routing.largeContextProvider || "gemini";

    const normalProvider =
      routing.normalProvider || "apinex";

    const preferred =
      contextTokens >= threshold
        ? largeProvider
        : normalProvider;

    const reason =
      contextTokens >= threshold
        ? "LARGE_CONTEXT"
        : "NORMAL_CONTEXT";

    const ordered = [
      preferred,
      ...fallbackOrder.filter(
        (id) => id !== preferred,
      ),
    ];

    return {
      ordered,
      mode: "auto",
      reason,
      selected: preferred,
    };
  }

  function getApiKey(provider) {
    const envName = provider.apiKeyEnv;

    const key = envName
      ? process.env[envName]
      : "";

    if (!key) {
      const error = new Error(
        `API key environment variable ${
          envName || "(not configured)"
        } is missing.`,
      );

      error.status = 500;
      error.type = "configuration_error";

      throw error;
    }

    return key;
  }

  function makeAttemptController(
    parentSignal,
    timeoutMs,
  ) {
    const controller = new AbortController();

    let timer = null;
    let onParentAbort = null;

    if (parentSignal) {
      if (parentSignal.aborted) {
        controller.abort();
      } else {
        onParentAbort = () => controller.abort();

        parentSignal.addEventListener(
          "abort",
          onParentAbort,
          { once: true },
        );
      }
    }

    if (timeoutMs > 0) {
      timer = setTimeout(
        () => controller.abort(),
        timeoutMs,
      );
    }

    return {
      signal: controller.signal,

      cleanup() {
        if (timer) {
          clearTimeout(timer);
        }

        if (
          parentSignal &&
          onParentAbort
        ) {
          parentSignal.removeEventListener(
            "abort",
            onParentAbort,
          );
        }
      },
    };
  }

  async function callProvider(
    id,
    payload,
    upstreamContext,
  ) {
    const provider = providers[id];

    if (!provider) {
      const error = new Error(
        `Unknown provider: ${id}`,
      );

      error.status = 500;
      error.type = "configuration_error";

      throw error;
    }

    const apiKey = getApiKey(provider);

    const timeoutMs = Number(
      provider.timeoutMs ||
        config.upstreamTimeoutMs ||
        600000,
    );

    const attempt = makeAttemptController(
      upstreamContext &&
        upstreamContext.signal,
      timeoutMs,
    );

    const statsEntry = providerStats(id);

    statsEntry.requests += 1;
    statsEntry.lastUsedAt = nowIso();

    const routedPayload = {
      ...payload,
      model: provider.model,
    };

    const url =
      `${normalizeBaseUrl(provider.baseUrl)}` +
      "/chat/completions";

    console.log(
      `[${new Date().toLocaleTimeString()}] ` +
      `[PROVIDER] ${provider.name || id} ` +
      `-> ${provider.model}`,
    );

    try {
      const response = await fetch(url, {
        method: "POST",

        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          ...(provider.headers || {}),
        },

        signal: attempt.signal,

        body: JSON.stringify(routedPayload),
      });

      statsEntry.lastStatus =
        response.status;

      if (!response.ok) {
        const text =
          await response.text();

        const error = new Error(
          `${provider.name || id} returned ` +
          `${response.status}: ${text}`,
        );

        error.status =
          response.status;

        error.provider = id;
        error.providerName =
          provider.name || id;

        throw error;
      }

      statsEntry.successes += 1;
      statsEntry.lastError = null;

      clearCooldown(id);

      console.log(
        `[${new Date().toLocaleTimeString()}] ` +
        `[STATUS] ${provider.name || id} ` +
        `-> ${response.status} OK`,
      );

      return {
        response,
        providerId: id,
        provider,
        model: provider.model,
      };
    } catch (error) {
      if (
        attempt.signal.aborted &&
        !(
          upstreamContext &&
          upstreamContext.signal &&
          upstreamContext.signal.aborted
        )
      ) {
        const timeoutError =
          new Error(
            `${provider.name || id} ` +
            `timed out after ${timeoutMs}ms`,
          );

        timeoutError.status = 504;
        timeoutError.code = "ETIMEDOUT";
        timeoutError.provider = id;

        error = timeoutError;
      }

      statsEntry.failures += 1;
      statsEntry.lastError =
        error.message;

      if (error.status) {
        statsEntry.lastStatus =
          error.status;
      }

      throw error;
    } finally {
      attempt.cleanup();
    }
  }

  async function call(
    req,
    payload,
    upstreamContext,
  ) {
    const contextTokens =
      estimateTokens(payload);

    const plan =
      candidateOrder(contextTokens);

    const skipped = [];

    console.log(
      `[${new Date().toLocaleTimeString()}] ` +
      `[ROUTE] mode=${plan.mode} ` +
      `context=~${formatTokens(contextTokens)} tokens ` +
      `reason=${plan.reason}`,
    );

    let lastError = null;

    for (const id of plan.ordered) {
      if (!providers[id]) {
        continue;
      }

      if (
        plan.mode !== "manual" &&
        isCoolingDown(id)
      ) {
        skipped.push(id);

        console.log(
          `[${new Date().toLocaleTimeString()}] ` +
          `[SKIP] ${providers[id].name || id} ` +
          `is in cooldown`,
        );

        continue;
      }

      try {
        const result =
          await callProvider(
            id,
            payload,
            upstreamContext,
          );

        result.contextTokens =
          contextTokens;

        result.routeReason =
          plan.reason;

        result.mode =
          plan.mode;

        result.skipped =
          skipped;

        return result;
      } catch (error) {
        lastError = error;

        const retryable =
          isRetryableError(error);

        console.error(
          `[${new Date().toLocaleTimeString()}] ` +
          `[ERROR] ${providers[id].name || id} ` +
          `-> ${error.status || error.code || "NETWORK"}` +
          `${
            retryable
              ? " [FALLBACK]"
              : " [NO FALLBACK]"
          }`,
        );

        if (retryable) {
          markCooldown(
            id,
            error.status || 504,
            error.message,
          );

          console.warn(
            `[${new Date().toLocaleTimeString()}] ` +
            `[COOLDOWN] ${providers[id].name || id} ` +
            `for ${Math.round(
              cooldownMs / 1000,
            )}s`,
          );

          continue;
        }

        throw error;
      }
    }

    if (lastError) {
      throw lastError;
    }

    const error = new Error(
      "No healthy provider is available.",
    );

    error.status = 503;
    error.type = "proxy_error";

    throw error;
  }

  function status() {
    const modeState =
      getModeState();

    const providersStatus = {};

    for (
      const [id, provider]
      of Object.entries(providers)
    ) {
      const statsEntry =
        providerStats(id);

      providersStatus[id] = {
        name:
          provider.name || id,

        model:
          provider.model,

        online:
          !isCoolingDown(id),

        cooldownUntil:
          statsEntry.cooldownUntil
            ? new Date(
                statsEntry.cooldownUntil,
              ).toISOString()
            : null,

        requests:
          statsEntry.requests,

        successes:
          statsEntry.successes,

        failures:
          statsEntry.failures,

        lastStatus:
          statsEntry.lastStatus,

        lastError:
          statsEntry.lastError,

        lastUsedAt:
          statsEntry.lastUsedAt,
      };
    }

    return {
      mode:
        modeState.mode,

      manualProvider:
        modeState.provider,

      thresholdTokens:
        threshold,

      fallbackOrder,

      providers:
        providersStatus,

      statePath,
    };
  }

  return {
    call,
    status,
    estimateTokens,
    getModeState,
  };
}

module.exports = {
  createRouter,
  estimateTokens,
  isRetryableError,
  isRetryableStatus,
};