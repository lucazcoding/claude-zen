const assert = require("node:assert/strict");
const http = require("node:http");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createRouter } = require("../router.js");
const { validateConfig } = require("../validate-config.js");

const serverPath = path.join(__dirname, "..", "server.js");

/* ============================================================
   HELPERS
   ============================================================ */

/** Sobe um upstream HTTP local em porta livre. Retorna handle. */
function startMock(handler) {
  const requests = [];

  const server = http.createServer((req, res) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", () => {
      let parsed = null;

      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        parsed = {};
      }

      requests.push({
        url: req.url,
        method: req.method,
        body: parsed,
      });

      handler(req, res, parsed, requests);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();

      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        port,
        requests,
        close() {
          return new Promise((done) => server.close(done));
        },
      });
    });
  });
}

function jsonUpstream(status, body) {
  return startMock((req, res) => {
    res.writeHead(status, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify(body));
  });
}

/* Lista de providers compartilhada com upstreams reais (não simulados)
   fica de fora: todos os providers nos testes apontam para mocks. */

function basicProvider(id, name, baseUrl, model, apiKeyEnv) {
  return {
    name,
    baseUrl,
    model,
    apiKeyEnv,
    timeoutMs: 5000,
  };
}

function baseConfig(providers, routing = {}) {
  const config = {
    configPath: path.join(os.tmpdir(), "claudezen-test-config.json"),
    routingStatePath: path.join(
      os.tmpdir(),
      `claudezen-state-${process.pid}.json`,
    ),
    routing: {
      mode: routing.mode || "auto",
      cooldownSeconds: 3600,
      largeContextThreshold: 100000,
      ...routing,
    },
    providers,
    upstreamTimeoutMs: 5000,
  };

  try {
    fs.rmSync(config.routingStatePath, { force: true });
    fs.rmSync(`${config.routingStatePath}.tmp`, { force: true });
  } catch {
    /* ignore */
  }

  return config;
}

/* ============================================================
   VALIDAÇÃO DA CONFIGURAÇÃO
   ============================================================ */

test("validateConfig: fallbackOrder com ID inexistente gera erro", () => {
  const result = validateConfig({
    routing: {
      fallbackOrder: ["apinex", "fantasma"],
    },
    providers: {
      apinex: {
        baseUrl: "http://x/v1",
        model: "m",
        apiKeyEnv: "K",
      },
    },
  });

  assert.ok(
    result.errors.some((e) => /fallbackOrder.*fantasma/.test(e)),
  );
});

test("validateConfig: normalProvider inválido gera erro", () => {
  const result = validateConfig({
    routing: {
      normalProvider: "nao-existe",
      largeContextProvider: "apinex",
      fallbackOrder: ["apinex"],
    },
    providers: {
      apinex: {
        baseUrl: "http://x/v1",
        model: "m",
        apiKeyEnv: "K",
      },
    },
  });

  assert.ok(
    result.errors.some((e) => /normalProvider.*nao-existe/.test(e)),
  );
});

test("validateConfig: provider sem model gera erro", () => {
  const result = validateConfig({
    routing: {
      fallbackOrder: ["apinex"],
      normalProvider: "apinex",
    },
    providers: {
      apinex: {
        baseUrl: "http://x/v1",
        apiKeyEnv: "K",
      },
    },
  });

  assert.ok(
    result.errors.some((e) => /apinex.*"model".*ausente|ausente ou vazio/.test(e)),
  );
});

test("validateConfig: provider sem baseUrl gera erro", () => {
  const result = validateConfig({
    routing: {
      fallbackOrder: ["apinex"],
    },
    providers: {
      apinex: {
        model: "m",
        apiKeyEnv: "K",
      },
    },
  });

  assert.ok(
    result.errors.some((e) => /"baseUrl".*ausente|ausente ou vazio/.test(e)),
  );
});

test("validateConfig: provider sem apiKeyEnv gera erro", () => {
  const result = validateConfig({
    routing: {
      fallbackOrder: ["apinex"],
    },
    providers: {
      apinex: {
        baseUrl: "http://x/v1",
        model: "m",
      },
    },
  });

  assert.ok(
    result.errors.some((e) => /"apiKeyEnv".*ausente|ausente ou vazio/.test(e)),
  );
});

test("validateConfig: config válido passa sem erros", () => {
  const result = validateConfig({
    routing: {
      fallbackOrder: ["apinex", "gemini"],
      normalProvider: "apinex",
      largeContextProvider: "gemini",
    },
    providers: {
      apinex: {
        baseUrl: "http://x/v1",
        model: "m1",
        apiKeyEnv: "K1",
      },
      gemini: {
        baseUrl: "http://y/v1",
        model: "m2",
        apiKeyEnv: "K2",
      },
    },
  });

  assert.deepEqual(result.errors, []);
});

test("validateConfig: ID duplicado no fallbackOrder vira aviso", () => {
  const result = validateConfig({
    routing: {
      fallbackOrder: ["apinex", "apinex"],
      normalProvider: "apinex",
    },
    providers: {
      apinex: {
        baseUrl: "http://x/v1",
        model: "m",
        apiKeyEnv: "K",
      },
    },
  });

  assert.deepEqual(result.errors, []);
  assert.ok(
    result.warnings.some((w) => /apinex.*mais de uma vez/.test(w)),
  );
});

test("validateConfig: provider declarado mas fora do fallback vira aviso", () => {
  const result = validateConfig({
    routing: {
      fallbackOrder: ["apinex"],
      normalProvider: "apinex",
    },
    providers: {
      apinex: {
        baseUrl: "http://x/v1",
        model: "m",
        apiKeyEnv: "K",
      },
      reserva: {
        baseUrl: "http://y/v1",
        model: "m2",
        apiKeyEnv: "K2",
      },
    },
  });

  assert.deepEqual(result.errors, []);
  assert.ok(
    result.warnings.some((w) => /reserva/.test(w)),
  );
});

/* ============================================================
   ABORT NA INICIALIZAÇÃO (process.exit(1))
   ============================================================ */

function runServerWithConfig(configObject) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cz-cfg-"));

  const configPath = path.join(dir, "config.json");

  fs.writeFileSync(configPath, JSON.stringify(configObject), "utf8");

  // Remove possíveis variáveis herdadas que sobrepõem o --config fornecido.
  const childEnv = { ...process.env };

  delete childEnv.CLAUDEZEN_CONFIG;
  delete childEnv.CLAUDE_OPENCODE_PROXY_CONFIG;

  const child = spawnSync(
    process.execPath,
    [serverPath, "--config", configPath],
    {
      encoding: "utf8",
      timeout: 15000,
      env: childEnv,
    },
  );

  fs.rmSync(dir, { recursive: true, force: true });

  return child;
}

test("inicialização aborta (exit 1) quando fallbackOrder referencia ID inexistente", () => {
  const child = runServerWithConfig({
    routing: {
      fallbackOrder: ["apinex", "fantasma"],
      normalProvider: "apinex",
      largeContextProvider: "apinex",
    },
    providers: {
      apinex: {
        baseUrl: "http://127.0.0.1:1/v1",
        model: "m",
        apiKeyEnv: "K_APINEX",
      },
    },
  });

  assert.equal(child.status, 1);
  assert.match(child.stderr, /fallbackOrder/);
});

test("inicialização aborta (exit 1) quando normalProvider é inválido", () => {
  const child = runServerWithConfig({
    routing: {
      fallbackOrder: ["apinex"],
      normalProvider: "nao-existe",
      largeContextProvider: "apinex",
    },
    providers: {
      apinex: {
        baseUrl: "http://127.0.0.1:1/v1",
        model: "m",
        apiKeyEnv: "K_APINEX",
      },
    },
  });

  assert.equal(child.status, 1);
  assert.match(child.stderr, /normalProvider/);
});

test("inicialização aborta (exit 1) quando provider não tem model", () => {
  const child = runServerWithConfig({
    routing: {
      fallbackOrder: ["apinex"],
      normalProvider: "apinex",
      largeContextProvider: "apinex",
    },
    providers: {
      apinex: {
        baseUrl: "http://127.0.0.1:1/v1",
        apiKeyEnv: "K_APINEX",
      },
    },
  });

  assert.equal(child.status, 1);
  assert.match(child.stderr, /"model"/);
});

/* ============================================================
   DERIVAÇÃO DO FALLBACKORDER
   ============================================================ */

test("fallbackOrder é derivado de providers quando ausente", () => {
  const router = createRouter(
    baseConfig(
      {
        a: basicProvider("a", "A", "http://127.0.0.1:1/v1", "m1", "KA"),
        b: basicProvider("b", "B", "http://127.0.0.1:1/v1", "m2", "KB"),
        c: basicProvider("c", "C", "http://127.0.0.1:1/v1", "m3", "KC"),
      },
      { mode: "auto" },
    ),
  );

  assert.deepEqual(router.status().fallbackOrder, ["a", "b", "c"]);
});

test("normalProvider e largeContextProvider derivam do primeiro/segundo provider", () => {
  const router = createRouter(
    baseConfig(
      {
        p1: basicProvider("p1", "P1", "http://127.0.0.1:1/v1", "m1", "K1"),
        p2: basicProvider("p2", "P2", "http://127.0.0.1:1/v1", "m2", "K2"),
        p3: basicProvider("p3", "P3", "http://127.0.0.1:1/v1", "m3", "K3"),
      },
      {},
    ),
  );

  const status = router.status();

  assert.equal(status.normalProvider, "p1");
  assert.equal(status.largeContextProvider, "p2");
});

/* ============================================================
   FALLBACK EM CADEIA
   ============================================================ */

test("fallback em cadeia: 503 em todos até o último responder 200", async () => {
  const apinex = await jsonUpstream(503, { error: "1" });
  const gemini = await jsonUpstream(503, { error: "2" });
  const qwen = await jsonUpstream(503, { error: "3" });
  const laguna = await jsonUpstream(200, { ok: true });

  try {
    process.env.K_APINEX = "k";
    process.env.K_GEMINI = "k";
    process.env.K_QWEN = "k";
    process.env.K_LAGUNA = "k";

    const router = createRouter(
      baseConfig(
        {
          apinex: basicProvider(
            "apinex",
            "APInex",
            apinex.url,
            "m-apinex",
            "K_APINEX",
          ),
          gemini: basicProvider(
            "gemini",
            "Gemini",
            gemini.url,
            "m-gemini",
            "K_GEMINI",
          ),
          "openrouter-qwen": basicProvider(
            "openrouter-qwen",
            "OpenRouter Qwen",
            qwen.url,
            "m-qwen",
            "K_QWEN",
          ),
          "openrouter-laguna": basicProvider(
            "openrouter-laguna",
            "OpenRouter Laguna",
            laguna.url,
            "m-laguna",
            "K_LAGUNA",
          ),
        },
        {
          fallbackOrder: [
            "apinex",
            "gemini",
            "openrouter-qwen",
            "openrouter-laguna",
          ],
        },
      ),
    );

    const result = await router.call(
      {},
      {
        model: "cliente",
        messages: [{ role: "user", content: "oi" }],
      },
    );

    assert.equal(result.providerId, "openrouter-laguna");
    assert.equal(result.response.status, 200);
    assert.equal(result.fallbackCount, 3);
    assert.equal(result.routeReason, "NORMAL_CONTEXT");

    assert.ok(apinex.requests.length > 0);
    assert.ok(gemini.requests.length > 0);
    assert.ok(qwen.requests.length > 0);
    assert.ok(laguna.requests.length > 0);
  } finally {
    process.env.K_APINEX = "";
    process.env.K_GEMINI = "";
    process.env.K_QWEN = "";
    process.env.K_LAGUNA = "";
    await apinex.close();
    await gemini.close();
    await qwen.close();
    await laguna.close();
  }
});

test("todos os providers 503 devolvem erro 503", async () => {
  const a = await jsonUpstream(503, { error: "1" });
  const b = await jsonUpstream(503, { error: "2" });

  try {
    process.env.KA = "k";
    process.env.KB = "k";

    const router = createRouter(
      baseConfig(
        {
          a: basicProvider("a", "A", a.url, "m1", "KA"),
          b: basicProvider("b", "B", b.url, "m2", "KB"),
        },
        { fallbackOrder: ["a", "b"] },
      ),
    );

    await assert.rejects(
      () =>
        router.call(
          {},
          { messages: [{ role: "user", content: "oi" }] },
        ),
      (error) => error.status === 503,
    );
  } finally {
    process.env.KA = "";
    process.env.KB = "";
    await a.close();
    await b.close();
  }
});

/* ============================================================
   COOLDOWN E MANUAL
   ============================================================ */

test("provider em cooldown é pulado no AUTO; MANUAL ignora cooldown", async () => {
  const apinex = await jsonUpstream(503, { error: "apinex" });
  const gemini = await jsonUpstream(503, { error: "gemini" });
  const qwen = await jsonUpstream(503, { error: "qwen" });

  // Laguna: 503 na 1ª chamada (entra em cooldown), depois 200.
  const lagunaBodies = [];
  const laguna = await startMock((req, res, parsed, requests) => {
    lagunaBodies.push(parsed);
    const success = requests.length >= 2;

    res.writeHead(success ? 200 : 503, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify(success ? { ok: true } : { error: "laguna" }));
  });

  const config = baseConfig(
    {
      apinex: basicProvider("apinex", "APInex", apinex.url, "m-apinex", "K_A"),
      gemini: basicProvider("gemini", "Gemini", gemini.url, "m-gemini", "K_G"),
      "openrouter-qwen": basicProvider(
        "openrouter-qwen",
        "OpenRouter Qwen",
        qwen.url,
        "m-qwen",
        "K_Q",
      ),
      "openrouter-laguna": basicProvider(
        "openrouter-laguna",
        "OpenRouter Laguna",
        laguna.url,
        "m-laguna",
        "K_L",
      ),
    },
    { fallbackOrder: ["apinex", "gemini", "openrouter-qwen", "openrouter-laguna"] },
  );

  const stateFile = config.routingStatePath;

  try {
    process.env.K_A = "k";
    process.env.K_G = "k";
    process.env.K_Q = "k";
    process.env.K_L = "k";

    const router = createRouter(config);

    function writeState(mode, provider) {
      fs.writeFileSync(
        stateFile,
        JSON.stringify({ mode, provider }),
        "utf8",
      );
    }

    // 1ª chamada AUTO: tudo 503; laguna entra em cooldown.
    writeState("auto", null);

    await assert.rejects(
      () =>
        router.call(
          {},
          { messages: [{ role: "user", content: "oi" }] },
        ),
      (error) => error.status === 503,
    );

    // Confirma que laguna está em cooldown.
    const cooled = router.status().providers["openrouter-laguna"];
    assert.ok(cooled.cooldownUntil, "laguna deveria estar em cooldown");

    // 2ª chamada AUTO: laguna responde 200, mas está em cooldown e é pulada.
    assert.equal(lagunaBodies.length, 1);

    await assert.rejects(
      () =>
        router.call(
          {},
          { messages: [{ role: "user", content: "oi2" }] },
        ),
      (error) => error.status === 503,
    );

    // Nenhuma nova tentativa contra a laguna enquanto em cooldown (AUTO).
    assert.equal(lagunaBodies.length, 1);

    // MANUAL com openrouter-laguna ignora cooldown e usa a laguna.
    writeState("manual", "openrouter-laguna");

    const manualResult = await router.call(
      {},
      { messages: [{ role: "user", content: "oi3" }] },
    );

    assert.equal(manualResult.providerId, "openrouter-laguna");
    assert.equal(manualResult.response.status, 200);
    assert.equal(manualResult.mode, "manual");
    assert.equal(lagunaBodies.length, 2);
  } finally {
    process.env.K_A = "";
    process.env.K_G = "";
    process.env.K_Q = "";
    process.env.K_L = "";
    await apinex.close();
    await gemini.close();
    await qwen.close();
    await laguna.close();
  }
});

/* ============================================================
   MESMO BASEURL, MODELOS DIFERENTES
   ============================================================ */

test("dois providers com o mesmo baseUrl enviam cada um o seu model", async () => {
  const received = [];

  // Um único servidor simulado representa o OpenRouter.
  const openRouter = await startMock((req, res, parsed) => {
    received.push(parsed.model);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, echoed: parsed.model }));
  });

  const config = baseConfig(
    {
      "openrouter-qwen": basicProvider(
        "openrouter-qwen",
        "OpenRouter Qwen",
        openRouter.url,
        "qwen/qwen3.8-27b:free",
        "KQ",
      ),
      "openrouter-laguna": basicProvider(
        "openrouter-laguna",
        "OpenRouter Laguna",
        openRouter.url,
        "poolside/laguna-s-2.1:free",
        "KL",
      ),
    },
    {
      // Sem fallbackOrder para exercitar a derivação de providers.
      mode: "manual",
    },
  );

  const stateFile = config.routingStatePath;

  try {
    process.env.KQ = "k";
    process.env.KL = "k";

    const router = createRouter(config);

    function writeState(provider) {
      fs.writeFileSync(
        stateFile,
        JSON.stringify({ mode: "manual", provider }),
        "utf8",
      );
    }

    writeState("openrouter-qwen");
    const r1 = await router.call(
      {},
      { messages: [{ role: "user", content: "hi" }] },
    );

    writeState("openrouter-laguna");
    const r2 = await router.call(
      {},
      { messages: [{ role: "user", content: "hi" }] },
    );

    // Ambos apontam para o mesmo servidor (mesmo baseUrl).
    assert.equal(openRouter.requests.length, 2);
    assert.ok(openRouter.requests.every((q) => q.url.includes("/chat/completions")));

    // Cada um enviou o seu model próprio.
    assert.deepEqual(received, [
      "qwen/qwen3.8-27b:free",
      "poolside/laguna-s-2.1:free",
    ]);

    assert.equal(r1.model, "qwen/qwen3.8-27b:free");
    assert.equal(r2.model, "poolside/laguna-s-2.1:free");
  } finally {
    process.env.KQ = "";
    process.env.KL = "";
    await openRouter.close();
  }
});