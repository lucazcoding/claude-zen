const fs = require("fs");
const path = require("path");

/*
 * ============================================================
 * CLAUDEZEN HYBRID ROUTER
 * ============================================================
 *
 * RESPONSABILIDADE DESTE ARQUIVO:
 *
 * 1. Analisar deterministicamente o payload recebido.
 * 2. Estimar tamanho/tokenização do contexto.
 * 3. Separar:
 *      - system
 *      - messages
 *      - tools
 *      - other
 * 4. Analisar cada message.
 * 5. Analisar cada tool.
 * 6. Escolher provider.
 * 7. Executar fallback.
 * 8. Capturar usage real quando o provider fornecer.
 * 9. Manter estatísticas acumuladas da sessão.
 * 10. Retornar um objeto completo de observabilidade.
 *
 * IMPORTANTE:
 * Este arquivo NÃO decide o que a IA deve dizer.
 * Toda análise abaixo é determinística e local.
 *
 * server.js pode utilizar o objeto "observability"
 * retornado por call() para imprimir o debug amigável.
 *
 * ============================================================
 */


/* ============================================================
 * CONSTANTES
 * ============================================================
 */

const BYTES_PER_TOKEN_ESTIMATE = 4;


/* ============================================================
 * UTILITÁRIOS
 * ============================================================
 */

function nowIso() {
  return new Date().toISOString();
}

function nowTime() {
  return new Date().toLocaleTimeString();
}

function byteLength(value) {
  return Buffer.byteLength(
    JSON.stringify(value ?? ""),
    "utf8"
  );
}

function estimateTokensFromBytes(bytes) {
  return Math.ceil(
    Math.max(0, bytes) / BYTES_PER_TOKEN_ESTIMATE
  );
}

function estimateTokens(payload) {
  const bytes = byteLength(payload || {});
  return estimateTokensFromBytes(bytes);
}

function formatTokens(tokens) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0
  }).format(
    Math.max(0, Number(tokens) || 0)
  );
}

function formatBytes(bytes) {
  bytes = Math.max(
    0,
    Number(bytes) || 0
  );

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function percentage(part, total) {
  if (!total || total <= 0) {
    return 0;
  }

  return Number(
    ((part / total) * 100).toFixed(2)
  );
}

function safeNumber(value, fallback = null) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return fallback;
  }

  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}


/* ============================================================
 * STATUS / RETRY
 * ============================================================
 */

function isRetryableStatus(status) {
  return (
    status === 402 ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  );
}

function isRetryableError(error) {
  if (!error) {
    return true;
  }

  if (
    error.status &&
    isRetryableStatus(error.status)
  ) {
    return true;
  }

  const retryableNames = [
    "AbortError",
    "TimeoutError"
  ];

  const retryableCodes = [
    "ECONNRESET",
    "ECONNREFUSED",
    "ECONNABORTED",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN"
  ];

  return (
    retryableNames.includes(error.name) ||
    retryableCodes.includes(error.code)
  );
}


/* ============================================================
 * STREAMING
 * ============================================================
 *
 * Em modo stream NÃO lemos o body inteiro. Devolvemos uma
 * Response cujo body repassa os chunks em tempo real.
 *
 * O cleanup (timeout + vínculo com o abort do cliente) só roda
 * quando o stream termina, falha ou é cancelado. Assim, se o
 * cliente desconectar no meio, o fetch upstream é abortado.
 * ============================================================
 */

function wrapStreamResponse(response, cleanup) {
  if (!response.body) {
    cleanup();
    return response;
  }

  const reader = response.body.getReader();

  let finished = false;

  const finish = () => {
    if (!finished) {
      finished = true;
      cleanup();
    }
  };

  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } =
          await reader.read();

        if (done) {
          finish();
          controller.close();
          return;
        }

        controller.enqueue(value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },

    async cancel(reason) {
      finish();

      try {
        await reader.cancel(reason);
      } catch {
        /* ignore */
      }
    }
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}


/* ============================================================
 * URL
 * ============================================================
 */

function normalizeBaseUrl(url) {
  const base = String(url || "")
    .replace(/\/+$/, "");

  return base.endsWith("/v1")
    ? base
    : `${base}/v1`;
}


/* ============================================================
 * EXTRAÇÃO DE CONTENT
 * ============================================================
 */

function extractContentValue(message) {
  if (!message) {
    return "";
  }

  if (
    message.content !== undefined
  ) {
    return message.content;
  }

  if (
    message.parts !== undefined
  ) {
    return message.parts;
  }

  return "";
}


/* ============================================================
 * ANÁLISE DE MESSAGE
 * ============================================================
 */

function analyzeMessage(message, index) {
  const bytes = byteLength(message);

  const content = extractContentValue(
    message
  );

  const contentBytes =
    byteLength(content);

  const tokens =
    estimateTokensFromBytes(bytes);

  const contentTokens =
    estimateTokensFromBytes(
      contentBytes
    );

  return {
    index,

    role:
      message?.role ||
      "unknown",

    bytes,

    tokens,

    contentBytes,

    contentTokens,

    percentageOfPayload: 0
  };
}


/* ============================================================
 * NOME DA TOOL
 * ============================================================
 */

function getToolName(tool) {
  return (
    tool?.name ||
    tool?.function?.name ||
    tool?.type ||
    "unnamed-tool"
  );
}


/* ============================================================
 * ANÁLISE DE TOOL
 * ============================================================
 */

function analyzeTool(tool, index) {
  const bytes = byteLength(tool);

  const tokens =
    estimateTokensFromBytes(bytes);

  return {
    index,

    name:
      getToolName(tool),

    type:
      tool?.type ||
      null,

    bytes,

    tokens,

    percentageOfTools: 0,

    percentageOfPayload: 0
  };
}


/* ============================================================
 * ANÁLISE COMPLETA DE CONTEXTO
 * ============================================================
 */

function analyzeContext(payload) {
  const safePayload =
    payload || {};

  const totalBytes =
    byteLength(safePayload);

  const totalTokens =
    estimateTokensFromBytes(
      totalBytes
    );

  /*
   * No formato OpenAI o system prompt vem DENTRO de
   * messages (role "system"/"developer"). Separamos
   * para que o bucket "system" reflita a realidade.
   */
  const allMessages =
    Array.isArray(
      safePayload.messages
    )
      ? safePayload.messages
      : [];

  const isSystemRole = (m) =>
    m &&
    (m.role === "system" ||
      m.role === "developer");

  const systemMessages =
    allMessages.filter(
      isSystemRole
    );

  const messages =
    allMessages.filter(
      (m) => !isSystemRole(m)
    );

  const topLevelSystem =
    safePayload.system;

  const hasTopLevelSystem =
    topLevelSystem !== undefined &&
    topLevelSystem !== null &&
    topLevelSystem !== "";

  const tools =
    Array.isArray(
      safePayload.tools
    )
      ? safePayload.tools
      : [];

  const systemBytes =
    (hasTopLevelSystem
      ? byteLength(topLevelSystem)
      : 0) +
    systemMessages.reduce(
      (sum, m) =>
        sum + byteLength(m),
      0
    );

  const messagesBytes =
    byteLength(messages);

  const toolsBytes =
    byteLength(tools);

  const knownBytes =
    systemBytes +
    messagesBytes +
    toolsBytes;

  const otherBytes =
    Math.max(
      0,
      totalBytes - knownBytes
    );

  const systemTokens =
    estimateTokensFromBytes(
      systemBytes
    );

  const messagesTokens =
    estimateTokensFromBytes(
      messagesBytes
    );

  const toolsTokens =
    estimateTokensFromBytes(
      toolsBytes
    );

  /*
   * "other" = resto exato em tokens, para que
   * system + messages + tools + other == total
   * (somar ceil() de cada parte estourava o total).
   */
  const otherTokens =
    Math.max(
      0,
      totalTokens -
        systemTokens -
        messagesTokens -
        toolsTokens
    );

  const analyzedMessages =
    messages.map(
      (message, index) =>
        analyzeMessage(
          message,
          index
        )
    );

  const analyzedTools =
    tools.map(
      (tool, index) =>
        analyzeTool(
          tool,
          index
        )
    );

  for (const message of analyzedMessages) {
    message.percentageOfPayload =
      percentage(
        message.tokens,
        totalTokens
      );
  }

  for (const tool of analyzedTools) {
    tool.percentageOfTools =
      percentage(
        tool.tokens,
        toolsTokens
      );

    tool.percentageOfPayload =
      percentage(
        tool.tokens,
        totalTokens
      );
  }

  const calculatedToolsBytes =
    analyzedTools.reduce(
      (sum, tool) =>
        sum + tool.bytes,
      0
    );

  const calculatedToolsTokens =
    estimateTokensFromBytes(
      calculatedToolsBytes
    );

  const largestTool =
    analyzedTools.length > 0
      ? [...analyzedTools]
          .sort(
            (a, b) =>
              b.tokens - a.tokens
          )[0]
      : null;

  const smallestTool =
    analyzedTools.length > 0
      ? [...analyzedTools]
          .sort(
            (a, b) =>
              a.tokens - b.tokens
          )[0]
      : null;

  return {
    payload: {
      bytes: totalBytes,
      formattedBytes:
        formatBytes(totalBytes),

      estimatedTokens:
        totalTokens
    },

    system: {
      count:
        systemMessages.length +
        (hasTopLevelSystem ? 1 : 0),

      bytes: systemBytes,
      formattedBytes:
        formatBytes(systemBytes),

      estimatedTokens:
        systemTokens,

      percentage:
        percentage(
          systemTokens,
          totalTokens
        )
    },

    messages: {
      count:
        messages.length,

      bytes:
        messagesBytes,

      formattedBytes:
        formatBytes(messagesBytes),

      estimatedTokens:
        messagesTokens,

      percentage:
        percentage(
          messagesTokens,
          totalTokens
        ),

      items:
        analyzedMessages
    },

    tools: {
      count:
        tools.length,

      bytes:
        toolsBytes,

      formattedBytes:
        formatBytes(toolsBytes),

      estimatedTokens:
        toolsTokens,

      percentage:
        percentage(
          toolsTokens,
          totalTokens
        ),

      calculatedBytes:
        calculatedToolsBytes,

      calculatedTokens:
        calculatedToolsTokens,

      items:
        analyzedTools,

      largest:
        largestTool,

      smallest:
        smallestTool
    },

    other: {
      bytes:
        otherBytes,

      formattedBytes:
        formatBytes(otherBytes),

      estimatedTokens:
        otherTokens,

      percentage:
        percentage(
          otherTokens,
          totalTokens
        )
    }
  };
}


/* ============================================================
 * USAGE REAL DO PROVIDER
 * ============================================================
 *
 * Diferentes providers podem retornar:
 *
 * usage.input_tokens
 * usage.prompt_tokens
 * usage.output_tokens
 * usage.completion_tokens
 * usage.total_tokens
 *
 * Normalizamos tudo para um formato único.
 * ============================================================
 */

function extractUsage(data) {
  const usage =
    data?.usage ||
    data?.response?.usage ||
    null;

  if (!usage) {
    return {
      available: false,

      inputTokens: null,
      outputTokens: null,
      totalTokens: null,

      raw: null
    };
  }

  const inputTokens =
    safeNumber(
      usage.input_tokens,
      safeNumber(
        usage.prompt_tokens,
        null
      )
    );

  const outputTokens =
    safeNumber(
      usage.output_tokens,
      safeNumber(
        usage.completion_tokens,
        null
      )
    );

  let totalTokens =
    safeNumber(
      usage.total_tokens,
      null
    );

  if (
    totalTokens === null &&
    inputTokens !== null &&
    outputTokens !== null
  ) {
    totalTokens =
      inputTokens +
      outputTokens;
  }

  return {
    available:
      inputTokens !== null ||
      outputTokens !== null ||
      totalTokens !== null,

    inputTokens,
    outputTokens,
    totalTokens,

    raw: usage
  };
}


/* ============================================================
 * SESSION OBSERVABILITY
 * ============================================================
 */

function createSessionStats() {
  return {
    startedAt:
      nowIso(),

    requests:
      0,

    successes:
      0,

    failures:
      0,

    fallbacks:
      0,

    estimatedInputTokens:
      0,

    realInputTokens:
      0,

    realOutputTokens:
      0,

    realTotalTokens:
      0,

    estimatedTotalTokens:
      0,

    totalLatencyMs:
      0,

    averageLatencyMs:
      0
  };
}


/* ============================================================
 * ROUTER
 * ============================================================
 */

function createRouter(config) {
  const routing =
    config.routing || {};

  const providers =
    config.providers || {};

  /*
   * Logs informativos (CONTEXT/ROUTE/PROVIDER/STATUS/ROUTER)
   * ficam silenciosos por padrão: o server.js já mostra um
   * bloco completo por requisição. Para ver tudo:
   *   - config.json  -> "routing": { "verbose": true }
   *   - ou variável  -> CLAUDEZEN_VERBOSE=1
   * Avisos importantes (fallback, cooldown, erros) sempre aparecem.
   */
  const verbose =
    routing.verbose === true ||
    process.env.CLAUDEZEN_VERBOSE === "1" ||
    process.env.CLAUDEZEN_VERBOSE === "true";

  function debug(message) {
    if (verbose) {
      console.log(message);
    }
  }

  const statePath =
    config.routingStatePath ||
    path.join(
      path.dirname(
        config.configPath ||
        process.cwd()
      ),
      "routing-state.json"
    );

  const cooldownMs =
    Math.max(
      0,
      Number(
        routing.cooldownSeconds ||
        300
      )
    ) * 1000;

  const threshold =
    Math.max(
      1,
      Number(
        routing.largeContextThreshold ||
        100000
      )
    );

  const fallbackOrder =
    Array.isArray(
      routing.fallbackOrder
    ) &&
    routing.fallbackOrder.length
      ? routing.fallbackOrder
      : [
          "apinex",
          "gemini",
          "openrouter"
        ];

  const stats =
    new Map();

  const session =
    createSessionStats();

  for (
    const id of Object.keys(
      providers
    )
  ) {
    stats.set(
      id,
      {
        requests: 0,
        successes: 0,
        failures: 0,

        lastStatus: null,
        lastError: null,
        lastUsedAt: null,

        cooldownUntil: 0
      }
    );
  }


  /* ==========================================================
   * PROVIDER STATS
   * ==========================================================
   */

  function providerStats(id) {
    if (!stats.has(id)) {
      stats.set(
        id,
        {
          requests: 0,
          successes: 0,
          failures: 0,

          lastStatus: null,
          lastError: null,
          lastUsedAt: null,

          cooldownUntil: 0
        }
      );
    }

    return stats.get(id);
  }


  /* ==========================================================
   * STATE
   * ==========================================================
   */

  function readState() {
    try {
      const state =
        JSON.parse(
          fs.readFileSync(
            statePath,
            "utf8"
          )
        );

      return (
        state &&
        typeof state === "object"
      )
        ? state
        : {};
    } catch {
      return {};
    }
  }


  /* ==========================================================
   * MODE
   * ==========================================================
   */

  function getModeState() {
    const fileState =
      readState();

    const configuredMode =
      String(
        routing.mode ||
        "auto"
      ).toLowerCase();

    const mode =
      String(
        fileState.mode ||
        configuredMode
      ).toLowerCase();

    const provider =
      fileState.provider ||
      routing.manualProvider ||
      null;

    if (
      mode === "manual" &&
      providers[provider]
    ) {
      return {
        mode: "manual",
        provider
      };
    }

    return {
      mode: "auto",
      provider: null
    };
  }


  /* ==========================================================
   * COOLDOWN
   * ==========================================================
   */

  function isCoolingDown(id) {
    return (
      providerStats(
        id
      ).cooldownUntil >
      Date.now()
    );
  }

  function markCooldown(
    id,
    status,
    errorMessage
  ) {
    const entry =
      providerStats(id);

    entry.cooldownUntil =
      Date.now() +
      cooldownMs;

    entry.lastStatus =
      status || null;

    entry.lastError =
      errorMessage || null;
  }

  function clearCooldown(id) {
    providerStats(
      id
    ).cooldownUntil = 0;
  }


  /* ==========================================================
   * ROUTING PLAN
   * ==========================================================
   */

  function candidateOrder(
    contextTokens
  ) {
    const modeState =
      getModeState();

    if (
      modeState.mode ===
      "manual"
    ) {
      const ordered = [
        modeState.provider
      ];

      for (
        const id of fallbackOrder
      ) {
        if (
          id !==
          modeState.provider
        ) {
          ordered.push(id);
        }
      }

      return {
        ordered,

        mode:
          "manual",

        reason:
          "MANUAL",

        selected:
          modeState.provider
      };
    }

    const largeProvider =
      routing.largeContextProvider ||
      "gemini";

    const normalProvider =
      routing.normalProvider ||
      "apinex";

    const preferred =
      contextTokens >= threshold
        ? largeProvider
        : normalProvider;

    const reason =
      contextTokens >= threshold
        ? "LARGE_CONTEXT"
        : "NORMAL_CONTEXT";

    const ordered = [
      preferred
    ];

    for (
      const id of fallbackOrder
    ) {
      if (
        id !== preferred
      ) {
        ordered.push(id);
      }
    }

    return {
      ordered,

      mode:
        "auto",

      reason,

      selected:
        preferred
    };
  }


  /* ==========================================================
   * API KEY
   * ==========================================================
   */

  function getApiKey(provider) {
    const envName =
      provider.apiKeyEnv;

    const key =
      envName
        ? process.env[envName]
        : "";

    if (!key) {
      const error =
        new Error(
          "API key environment variable " +
          (envName ||
            "(not configured)") +
          " is missing."
        );

      error.status =
        500;

      error.type =
        "configuration_error";

      throw error;
    }

    return key;
  }


  /* ==========================================================
   * ABORT / TIMEOUT
   * ==========================================================
   */

  function makeAttemptController(
    parentSignal,
    timeoutMs
  ) {
    const controller =
      new AbortController();

    let timer = null;
    let onParentAbort = null;

    if (parentSignal) {
      if (
        parentSignal.aborted
      ) {
        controller.abort();
      } else {
        onParentAbort = () => {
          controller.abort();
        };

        parentSignal.addEventListener(
          "abort",
          onParentAbort,
          {
            once: true
          }
        );
      }
    }

    if (timeoutMs > 0) {
      timer =
        setTimeout(
          () => {
            controller.abort();
          },
          timeoutMs
        );
    }

    return {
      signal:
        controller.signal,

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
            onParentAbort
          );
        }
      }
    };
  }


  /* ==========================================================
   * PROVIDER CALL
   * ==========================================================
   */

  async function callProvider(
    id,
    payload,
    upstreamContext
  ) {
    const provider =
      providers[id];

    if (!provider) {
      const error =
        new Error(
          "Unknown provider: " +
          id
        );

      error.status =
        500;

      error.type =
        "configuration_error";

      throw error;
    }

    const apiKey =
      getApiKey(provider);

    const timeoutMs =
      Number(
        provider.timeoutMs ||
        config.upstreamTimeoutMs ||
        600000
      );

    const attempt =
      makeAttemptController(
        upstreamContext?.signal,
        timeoutMs
      );

    const entry =
      providerStats(id);

    entry.requests += 1;

    entry.lastUsedAt =
      nowIso();

    const routedPayload = {
      ...payload,

      model:
        provider.model
    };

    const url =
      normalizeBaseUrl(
        provider.baseUrl
      ) +
      "/chat/completions";

    debug(
      "[" +
      nowTime() +
      "] [PROVIDER] " +
      (
        provider.name ||
        id
      ) +
      " -> " +
      provider.model
    );

    const providerStarted =
      Date.now();

    const wantsStream =
      payload?.stream === true;

    let deferCleanup =
      false;

    try {
      const response =
        await fetch(
          url,
          {
            method:
              "POST",

            headers: {
              authorization:
                "Bearer " +
                apiKey,

              "content-type":
                "application/json",

              ...(provider.headers ||
                {})
            },

            signal:
              attempt.signal,

            body:
              JSON.stringify(
                routedPayload
              )
          }
        );

      const providerLatencyMs =
        Date.now() -
        providerStarted;

      entry.lastStatus =
        response.status;

      if (!response.ok) {
        const text =
          await response.text();

        const error =
          new Error(
            (
              provider.name ||
              id
            ) +
            " returned " +
            response.status +
            ": " +
            text
          );

        error.status =
          response.status;

        error.provider =
          id;

        error.providerName =
          provider.name ||
          id;

        error.providerLatencyMs =
          providerLatencyMs;

        throw error;
      }

      /*
       * STREAMING: não bufferiza. Devolve o body em tempo real.
       * O usage chega no final do stream e é informado pelo
       * server.js via router.recordUsage().
       */
      if (wantsStream) {
        entry.successes += 1;
        entry.lastError =
          null;

        clearCooldown(id);

        debug(
          "[" +
          nowTime() +
          "] [STATUS] " +
          (
            provider.name ||
            id
          ) +
          " -> " +
          response.status +
          " OK (stream)"
        );

        deferCleanup =
          true;

        return {
          response:
            wrapStreamResponse(
              response,
              attempt.cleanup
            ),

          responseData:
            null,

          responseText:
            null,

          providerId:
            id,

          provider,

          model:
            provider.model,

          providerLatencyMs,

          streaming:
            true,

          usage:
            extractUsage(null)
        };
      }

      /*
       * Lemos o body uma única vez.
       *
       * Isso permite:
       * - retornar a resposta original ao server
       * - analisar usage
       */
      const responseText =
        await response.text();

      let responseData =
        null;

      try {
        responseData =
          JSON.parse(
            responseText
          );
      } catch {
        responseData =
          null;
      }

      const usage =
        extractUsage(
          responseData
        );

      entry.successes += 1;
      entry.lastError =
        null;

      clearCooldown(id);

      debug(
        "[" +
        nowTime() +
        "] [STATUS] " +
        (
          provider.name ||
          id
        ) +
        " -> " +
        response.status +
        " OK"
      );

      /*
       * Reconstrói Response para que
       * server.js continue podendo
       * consumir o resultado.
       */
      const rebuiltResponse =
        new Response(
          responseText,
          {
            status:
              response.status,

            statusText:
              response.statusText,

            headers:
              response.headers
          }
        );

      return {
        response:
          rebuiltResponse,

        responseData,

        responseText,

        providerId:
          id,

        provider,

        model:
          provider.model,

        providerLatencyMs,

        usage
      };
    } catch (error) {
      if (
        attempt.signal.aborted &&
        !(
          upstreamContext
            ?.signal
            ?.aborted
        )
      ) {
        const timeoutError =
          new Error(
            (
              provider.name ||
              id
            ) +
            " timed out after " +
            timeoutMs +
            "ms"
          );

        timeoutError.status =
          504;

        timeoutError.code =
          "ETIMEDOUT";

        timeoutError.provider =
          id;

        error =
          timeoutError;
      }

      entry.failures += 1;

      entry.lastError =
        error.message;

      if (error.status) {
        entry.lastStatus =
          error.status;
      }

      throw error;
    } finally {
      if (!deferCleanup) {
        attempt.cleanup();
      }
    }
  }


  /* ==========================================================
   * MAIN CALL
   * ==========================================================
   */

  async function call(
    req,
    payload,
    upstreamContext
  ) {
    const requestStarted =
      Date.now();

    session.requests += 1;

    /*
     * ----------------------------------------------------------
     * CONTEXTO
     * ----------------------------------------------------------
     */

    const context =
      analyzeContext(
        payload
      );

    const contextTokens =
      context.payload
        .estimatedTokens;

    debug(
      "[" +
      nowTime() +
      "] [CONTEXT] Estimated request size: ~" +
      formatTokens(
        contextTokens
      ) +
      " tokens"
    );

    /*
     * ----------------------------------------------------------
     * PLANO DE ROTEAMENTO
     * ----------------------------------------------------------
     */

    const plan =
      candidateOrder(
        contextTokens
      );

    const skipped = [];

    debug(
      "[" +
      nowTime() +
      "] [ROUTE] mode=" +
      plan.mode +
      " context=~" +
      formatTokens(
        contextTokens
      ) +
      " tokens reason=" +
      plan.reason
    );

    let lastError =
      null;

    let fallbackCount =
      0;

    /*
     * ----------------------------------------------------------
     * TENTATIVAS
     * ----------------------------------------------------------
     */

    for (
      const id of plan.ordered
    ) {
      if (!providers[id]) {
        continue;
      }

      if (
        plan.mode !== "manual" &&
        isCoolingDown(id)
      ) {
        skipped.push(id);

        console.warn(
          "[" +
          nowTime() +
          "] ⏭️  " +
          (
            providers[id]
              .name ||
            id
          ) +
          " pulado (em cooldown)"
        );

        continue;
      }

      try {
        const result =
          await callProvider(
            id,
            payload,
            upstreamContext
          );

        /*
         * ------------------------------------------------------
         * USAGE
         * ------------------------------------------------------
         */

        const usage =
          result.usage;

        const estimatedInputTokens =
          contextTokens;

        const realInputTokens =
          usage.inputTokens;

        const realOutputTokens =
          usage.outputTokens;

        const realTotalTokens =
          usage.totalTokens;

        /*
         * Se não houver usage real,
         * usamos apenas estimativa para
         * análise local.
         */
        const estimatedTotalTokens =
          estimatedInputTokens +
          (
            realOutputTokens || 0
          );

        /*
         * ------------------------------------------------------
         * SESSION
         * ------------------------------------------------------
         */

        session.successes += 1;

        session.estimatedInputTokens +=
          estimatedInputTokens;

        session.estimatedTotalTokens +=
          estimatedTotalTokens;

        if (
          realInputTokens !== null
        ) {
          session.realInputTokens +=
            realInputTokens;
        }

        if (
          realOutputTokens !== null
        ) {
          session.realOutputTokens +=
            realOutputTokens;
        }

        if (
          realTotalTokens !== null
        ) {
          session.realTotalTokens +=
            realTotalTokens;
        }

        if (
          fallbackCount > 0
        ) {
          session.fallbacks += 1;
        }

        const latencyMs =
          Date.now() -
          requestStarted;

        session.totalLatencyMs +=
          latencyMs;

        session.averageLatencyMs =
          Math.round(
            session.totalLatencyMs /
            Math.max(1, session.successes)
          );

        /*
         * ------------------------------------------------------
         * OBSERVABILIDADE
         * ------------------------------------------------------
         */

        const observability = {
          request: {
            timestamp:
              nowIso(),

            requestNumber:
              session.requests,

            success:
              true
          },

          context: {
            totalBytes:
              context.payload.bytes,

            totalTokens:
              context.payload
                .estimatedTokens,

            system:
              context.system,

            messages:
              context.messages,

            tools:
              context.tools,

            other:
              context.other
          },

          routing: {
            mode:
              plan.mode,

            reason:
              plan.reason,

            preferredProvider:
              plan.selected,

            selectedProvider:
              id,

            selectedProviderName:
              result.provider.name ||
              id,

            model:
              result.model,

            fallbackUsed:
              fallbackCount > 0,

            fallbackCount,

            skippedProviders:
              skipped
          },

          http: {
            status:
              result.response.status,

            ok:
              result.response.ok,

            streaming:
              result.streaming === true,

            latencyMs
          },

          provider: {
            id,

            name:
              result.provider.name ||
              id,

            model:
              result.model,

            latencyMs:
              result.providerLatencyMs
          },

          usage: {
            available:
              usage.available,

            inputTokens:
              realInputTokens,

            outputTokens:
              realOutputTokens,

            totalTokens:
              realTotalTokens,

            inputSource:
              realInputTokens !== null
                ? "provider"
                : "estimated",

            estimatedInputTokens,

            estimatedTotalTokens
          },

          session: {
            startedAt:
              session.startedAt,

            requests:
              session.requests,

            successes:
              session.successes,

            failures:
              session.failures,

            fallbacks:
              session.fallbacks,

            estimatedInputTokens:
              session.estimatedInputTokens,

            estimatedTotalTokens:
              session.estimatedTotalTokens,

            realInputTokens:
              session.realInputTokens,

            realOutputTokens:
              session.realOutputTokens,

            realTotalTokens:
              session.realTotalTokens,

            averageLatencyMs:
              session.averageLatencyMs
          }
        };

        /*
         * ------------------------------------------------------
         * ROUTER LOG
         * ------------------------------------------------------
         */

        debug(
          "[" +
          nowTime() +
          "] [ROUTER] " +
          plan.mode.toUpperCase() +
          " -> " +
          (
            result.provider.name ||
            id
          ) +
          " -> " +
          result.model +
          " -> ~" +
          formatTokens(
            contextTokens
          ) +
          " tokens -> " +
          plan.reason
        );

        return {
          ...result,

          contextTokens,

          context,

          usage,

          routeReason:
            plan.reason,

          mode:
            plan.mode,

          skipped,

          fallbackCount,

          observability
        };
      } catch (error) {
        lastError =
          error;

        const retryable =
          isRetryableError(
            error
          );

        const failedName =
          providers[id]?.name ||
          id;

        const statusHints = {
          402: "cota ou cobrança",
          429: "limite de requisições",
          504: "timeout"
        };

        const failedCode =
          (error.status ||
            error.code ||
            "rede") +
          (statusHints[error.status]
            ? " · " +
              statusHints[error.status]
            : "");

        console.error(
          "[" +
          nowTime() +
          "] " +
          (retryable ? "⚠️  " : "✗ ") +
          failedName +
          " falhou (" +
          failedCode +
          ")" +
          (
            retryable
              ? " — acionando fallback"
              : " — erro não recuperável, sem fallback"
          )
        );

        if (retryable) {
          markCooldown(
            id,
            error.status ||
              504,
            error.message
          );

          console.warn(
            "[" +
            nowTime() +
            "] 🧊 " +
            failedName +
            " em cooldown por " +
            Math.round(
              cooldownMs / 1000
            ) +
            "s"
          );

          fallbackCount += 1;

          continue;
        }

        /*
         * Erro não-retryable.
         * NÃO faz fallback.
         */
        session.failures += 1;

        throw error;
      }
    }

    /*
     * ----------------------------------------------------------
     * TODOS OS PROVIDERS FALHARAM
     * ----------------------------------------------------------
     */

    session.failures += 1;

    if (lastError) {
      throw lastError;
    }

    const error =
      new Error(
        "No healthy provider is available."
      );

    error.status =
      503;

    error.type =
      "proxy_error";

    throw error;
  }


  /* ==========================================================
   * USAGE DE STREAM
   * ==========================================================
   *
   * Em stream o usage só aparece no fim da resposta, depois que
   * call() já retornou. O server.js chama recordUsage() uma única
   * vez por stream (não chamar para respostas não-stream: nelas o
   * router já contabiliza o usage sozinho).
   */

  function recordUsage(usage) {
    if (
      !usage ||
      typeof usage !== "object"
    ) {
      return null;
    }

    const inputTokens =
      safeNumber(
        usage.input_tokens,
        safeNumber(
          usage.inputTokens,
          safeNumber(
            usage.prompt_tokens,
            null
          )
        )
      );

    const outputTokens =
      safeNumber(
        usage.output_tokens,
        safeNumber(
          usage.outputTokens,
          safeNumber(
            usage.completion_tokens,
            null
          )
        )
      );

    let totalTokens =
      safeNumber(
        usage.total_tokens,
        safeNumber(
          usage.totalTokens,
          null
        )
      );

    if (
      totalTokens === null &&
      inputTokens !== null &&
      outputTokens !== null
    ) {
      totalTokens =
        inputTokens +
        outputTokens;
    }

    if (inputTokens !== null) {
      session.realInputTokens +=
        inputTokens;
    }

    if (outputTokens !== null) {
      session.realOutputTokens +=
        outputTokens;

      session.estimatedTotalTokens +=
        outputTokens;
    }

    if (totalTokens !== null) {
      session.realTotalTokens +=
        totalTokens;
    }

    return {
      inputTokens,
      outputTokens,
      totalTokens
    };
  }


  /* ==========================================================
   * SESSION STATUS
   * ==========================================================
   */

  function getSessionStats() {
    return {
      ...session,

      uptimeMs:
        Math.max(
          0,
          Date.now() -
          new Date(
            session.startedAt
          ).getTime()
        ),

      averageLatencyMs:
        session.averageLatencyMs
    };
  }


  /* ==========================================================
   * STATUS DO ROUTER
   * ==========================================================
   */

  function status() {
    const modeState =
      getModeState();

    const providersStatus =
      {};

    for (
      const id of Object.keys(
        providers
      )
    ) {
      const provider =
        providers[id];

      const entry =
        providerStats(id);

      providersStatus[id] = {
        name:
          provider.name ||
          id,

        model:
          provider.model,

        online:
          !isCoolingDown(id),

        cooldownUntil:
          entry.cooldownUntil
            ? new Date(
                entry.cooldownUntil
              ).toISOString()
            : null,

        requests:
          entry.requests,

        successes:
          entry.successes,

        failures:
          entry.failures,

        lastStatus:
          entry.lastStatus,

        lastError:
          entry.lastError,

        lastUsedAt:
          entry.lastUsedAt
      };
    }

    return {
      mode:
        modeState.mode,

      manualProvider:
        modeState.provider,

      thresholdTokens:
        threshold,

      fallbackOrder:
        fallbackOrder,

      providers:
        providersStatus,

      session:
        getSessionStats(),

      statePath:
        statePath
    };
  }


  /* ==========================================================
   * API PÚBLICA
   * ==========================================================
   */

  return {
    call,

    recordUsage,

    status,

    estimateTokens,

    analyzeContext,

    getModeState,

    getSessionStats
  };
}


/* ============================================================
 * EXPORTS
 * ============================================================
 */

module.exports = {
  createRouter,

  estimateTokens,

  analyzeContext,

  extractUsage,

  isRetryableError,

  isRetryableStatus
};