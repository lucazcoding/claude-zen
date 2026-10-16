const assert = require("node:assert/strict");
const http = require("node:http");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { validateConfig } = require("../validate-config.js");
const { openAdminBrowser, createServer } = require("../server.js");

const SERVER_PATH = path.join(__dirname, "..", "server.js");
const EXAMPLE_PATH = path.join(__dirname, "..", "config.example.json");

/* ============================================================
   UPSTREAM MOCK HELPER
   ============================================================ */

function startMockUpstream(handler) {
  const requests = [];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        parsed = {};
      }
      requests.push({ url: req.url, method: req.method, body: parsed });
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

function requestHttp(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {
          json = data;
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: json,
          rawBody: data,
        });
      });
    });

    req.on("error", reject);
    if (postData) {
      req.write(
        typeof postData === "string" ? postData : JSON.stringify(postData),
      );
    }
    req.end();
  });
}

/* ============================================================
   PASSO 2: CONFIG.EXAMPLE.JSON
   ============================================================ */

test("config.example.json é JSON válido e aceito pelo validador com aviso de providers vazio", () => {
  assert.ok(fs.existsSync(EXAMPLE_PATH), "config.example.json deve existir");
  const raw = fs.readFileSync(EXAMPLE_PATH, "utf8");
  const parsed = JSON.parse(raw);

  assert.equal(parsed.listen.host, "127.0.0.1");
  assert.equal(parsed.listen.port, 8787);
  assert.equal(parsed.routing.mode, "auto");
  assert.equal(parsed.routing.largeContextThreshold, 100000);
  assert.equal(parsed.routing.cooldownSeconds, 300);
  assert.deepEqual(parsed.providers, {});

  const { errors, warnings } = validateConfig(parsed);
  assert.equal(errors.length, 0, `Não deve conter erros: ${errors.join("; ")}`);
  assert.ok(
    warnings.some((w) => w.includes("Nenhum provider configurado")),
    "Deve conter aviso sobre providers vazio",
  );
});

test("primeira execução: cria config.json a partir de config.example.json se ausente", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cz-firstrun-"));
  const tmpConfig = path.join(tmpDir, "config.json");

  assert.equal(fs.existsSync(tmpConfig), false);

  const env = { ...process.env, CLAUDEZEN_CONFIG: tmpConfig };
  delete env.CLAUDE_OPENCODE_PROXY_CONFIG;

  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
      const bridge = require(${JSON.stringify(SERVER_PATH)});
      const cfg = bridge.getConfig();
      console.log('CREATED:' + cfg.createdFromExample);
    `,
    ],
    { env, encoding: "utf8", timeout: 10000 },
  );

  assert.equal(child.status, 0, `Erro de execução: ${child.stderr}`);
  assert.ok(
    fs.existsSync(tmpConfig),
    "config.json deve ter sido criado no diretório temporário",
  );
  assert.ok(
    child.stdout.includes("CREATED:true"),
    "createdFromExample deve ser true",
  );

  const createdContent = JSON.parse(fs.readFileSync(tmpConfig, "utf8"));
  assert.deepEqual(createdContent.providers, {});

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ============================================================
   PASSO 3: MODO DE CONFIGURAÇÃO (SEM PROVIDER / SEM CHAVE)
   ============================================================ */

test("subir com providers vazios emite aviso e não aborta", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cz-empty-prov-"));
  const tmpConfig = path.join(tmpDir, "config.json");

  fs.writeFileSync(
    tmpConfig,
    JSON.stringify({
      listen: { host: "127.0.0.1", port: 0 },
      routing: { mode: "auto" },
      providers: {},
    }),
    "utf8",
  );

  const env = { ...process.env, CLAUDEZEN_CONFIG: tmpConfig };
  delete env.CLAUDE_OPENCODE_PROXY_CONFIG;

  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
      const { assertConfigValid, getConfig } = require(${JSON.stringify(SERVER_PATH)});
      assertConfigValid(getConfig());
      console.log('VALID_SUCCESS');
    `,
    ],
    { env, encoding: "utf8", timeout: 10000 },
  );

  assert.equal(child.status, 0);
  assert.ok(child.stdout.includes("VALID_SUCCESS"));
  assert.ok(
    child.stderr.includes(
      "Nenhum provider configurado; abra o painel /admin",
    ),
    "Deve emitir aviso no stderr",
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("/v1 sem provider utilizável retorna 503 com mensagem em português e sem token", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cz-no-prov-srv-"));
  const tmpConfig = path.join(tmpDir, "config.json");

  fs.writeFileSync(
    tmpConfig,
    JSON.stringify({
      listen: { host: "127.0.0.1", port: 0 },
      routing: { mode: "auto" },
      providers: {},
    }),
    "utf8",
  );

  const originalEnv = process.env.CLAUDEZEN_CONFIG;
  const originalToken = process.env.CLAUDEZEN_ADMIN_TOKEN;

  process.env.CLAUDEZEN_CONFIG = tmpConfig;
  process.env.CLAUDEZEN_ADMIN_TOKEN = "segredo-teste-nao-vazar-12345";

  delete require.cache[require.resolve("../server.js")];
  delete require.cache[require.resolve("../secrets-store.js")];
  const { createServer } = require("../server.js");
  const srv = createServer();

  try {
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;

    const res = await requestHttp(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/messages",
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      {
        model: "any",
        messages: [{ role: "user", content: "oi" }],
      },
    );

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.type, "error");
    assert.equal(res.body.error.type, "proxy_error");
    assert.equal(
      res.body.error.message,
      `ClaudeZen ainda não tem nenhum provider com chave configurada. Abra http://127.0.0.1:${port}/admin para configurar.`,
    );
    assert.ok(
      !res.rawBody.includes("segredo-teste-nao-vazar-12345"),
      "Token não deve aparecer na mensagem de erro",
    );
  } finally {
    await new Promise((resolve) => srv.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv) process.env.CLAUDEZEN_CONFIG = originalEnv;
    else delete process.env.CLAUDEZEN_CONFIG;
    if (originalToken) process.env.CLAUDEZEN_ADMIN_TOKEN = originalToken;
    else delete process.env.CLAUDEZEN_ADMIN_TOKEN;
  }
});

test("criar primeiro provider pela API em config vazia habilita proxy /v1 com upstream simulado", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cz-first-provider-"));
  const tmpConfig = path.join(tmpDir, "config.json");
  const tmpSecrets = path.join(tmpDir, "secrets.json");

  fs.writeFileSync(
    tmpConfig,
    JSON.stringify({
      listen: { host: "127.0.0.1", port: 0 },
      routing: { mode: "auto" },
      providers: {},
    }),
    "utf8",
  );

  const mock = await startMockUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-mock",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Olá do upstream!" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      }),
    );
  });

  const originalEnv = process.env.CLAUDEZEN_CONFIG;
  const originalSecrets = process.env.CLAUDEZEN_SECRETS_PATH;
  process.env.CLAUDEZEN_CONFIG = tmpConfig;
  process.env.CLAUDEZEN_SECRETS_PATH = tmpSecrets;

  delete require.cache[require.resolve("../server.js")];
  delete require.cache[require.resolve("../secrets-store.js")];
  const { createServer, getAdminToken } = require("../server.js");
  const srv = createServer();

  try {
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;
    const token = getAdminToken();

    // 1. Criar o primeiro provider
    const createRes = await requestHttp(
      {
        host: "127.0.0.1",
        port,
        path: "/admin/api/providers",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": token,
        },
      },
      {
        id: "mock-provider",
        name: "Mock Provider",
        baseUrl: mock.url,
        model: "mock-model",
        apiKey: "chave-mock-123",
      },
    );

    assert.equal(createRes.statusCode, 201);

    // 2. Requisição para /v1 agora deve responder 200 via upstream
    const v1Res = await requestHttp(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/messages",
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      {
        model: "mock-model",
        messages: [{ role: "user", content: "Teste de primeiro provider" }],
      },
    );

    assert.equal(v1Res.statusCode, 200);
    assert.equal(v1Res.body.content[0].text, "Olá do upstream!");
  } finally {
    await new Promise((resolve) => srv.close(resolve));
    await mock.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv) process.env.CLAUDEZEN_CONFIG = originalEnv;
    else delete process.env.CLAUDEZEN_CONFIG;
    if (originalSecrets) process.env.CLAUDEZEN_SECRETS_PATH = originalSecrets;
    else delete process.env.CLAUDEZEN_SECRETS_PATH;
  }
});

/* ============================================================
   PASSO 4: FLAG --OPEN E INJEÇÃO DO SPAWN
   ============================================================ */

test("openAdminBrowser injeta spawn e passa argumentos esperados por plataforma sem shell", () => {
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return {
      on: () => {},
      unref: () => {},
    };
  };

  const testUrl = "http://127.0.0.1:8787/admin?token=abc";

  // Teste na plataforma real
  openAdminBrowser(testUrl, fakeSpawn);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.stdio, "ignore");
  assert.equal(calls[0].opts.shell, undefined, "NUNCA deve usar shell: true");

  if (process.platform === "win32") {
    assert.equal(calls[0].cmd, "cmd");
    assert.deepEqual(calls[0].args, ["/c", "start", "", testUrl]);
  } else if (process.platform === "darwin") {
    assert.equal(calls[0].cmd, "open");
    assert.deepEqual(calls[0].args, [testUrl]);
  } else {
    assert.equal(calls[0].cmd, "xdg-open");
    assert.deepEqual(calls[0].args, [testUrl]);
  }
});

test("openAdminBrowser captura falha de spawn sem derrubar processo", () => {
  const failingSpawn = () => {
    throw new Error("Falha intencional de teste de spawn");
  };

  assert.doesNotThrow(() => {
    openAdminBrowser("http://127.0.0.1:8787/admin", failingSpawn);
  });
});

/* ============================================================
   PASSO 5: PRESETS
   ============================================================ */

const PRESETS_PATH = path.join(__dirname, "..", "presets.json");
const { normalizeBaseUrl } = require("../server.js");

test("presets.json é JSON válido com campos id, label, baseUrl", () => {
  assert.ok(fs.existsSync(PRESETS_PATH), "presets.json deve existir");
  const raw = fs.readFileSync(PRESETS_PATH, "utf8");
  const parsed = JSON.parse(raw);

  assert.ok(Array.isArray(parsed), "presets deve ser array");
  assert.ok(parsed.length > 0, "presets não pode estar vazio");

  for (const preset of parsed) {
    assert.ok(
      typeof preset.id === "string" && preset.id.length > 0,
      `preset sem id: ${JSON.stringify(preset)}`,
    );
    assert.ok(
      typeof preset.label === "string" && preset.label.length > 0,
      `preset sem label: ${preset.id}`,
    );
    assert.ok(
      typeof preset.baseUrl === "string",
      `preset sem baseUrl: ${preset.id}`,
    );
  }
});

test("para cada preset não-custom, URL final de chat/completions é normalizeBaseUrl(baseUrl) + '/chat/completions'", () => {
  const raw = fs.readFileSync(PRESETS_PATH, "utf8");
  const presets = JSON.parse(raw);

  for (const preset of presets) {
    if (preset.id === "custom" || !preset.baseUrl) continue;

    const normalized = normalizeBaseUrl(preset.baseUrl);
    const chatUrl = normalized + "/chat/completions";

    // Deve terminar em /chat/completions
    assert.ok(
      chatUrl.endsWith("/chat/completions"),
      `preset "${preset.id}": URL de chat não termina corretamente: ${chatUrl}`,
    );

    // normalizeBaseUrl não deve duplicar /v1 se já presente
    const base = preset.baseUrl.replace(/\/+$/, "");
    if (base.endsWith("/v1")) {
      assert.equal(
        normalized,
        base,
        `preset "${preset.id}": normalizeBaseUrl alterou URL que já terminava em /v1`,
      );
    }
  }
});

test("/admin/api/presets requer token e não contém chave nem token na resposta", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cz-presets-sec-"));
  const tmpConfig = path.join(tmpDir, "config.json");

  fs.writeFileSync(
    tmpConfig,
    JSON.stringify({
      listen: { host: "127.0.0.1", port: 0 },
      routing: { mode: "auto" },
      providers: {},
    }),
    "utf8",
  );

  const originalEnv = process.env.CLAUDEZEN_CONFIG;
  const originalToken = process.env.CLAUDEZEN_ADMIN_TOKEN;

  process.env.CLAUDEZEN_CONFIG = tmpConfig;
  process.env.CLAUDEZEN_ADMIN_TOKEN = "token-secreto-presets-xyz";

  delete require.cache[require.resolve("../server.js")];
  delete require.cache[require.resolve("../secrets-store.js")];
  const { createServer: createSrv, getAdminToken } = require("../server.js");
  const srv = createSrv();

  try {
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;
    const token = getAdminToken();

    // Sem token: deve retornar 401
    const noAuth = await requestHttp({
      host: "127.0.0.1",
      port,
      path: "/admin/api/presets",
      method: "GET",
    });
    assert.equal(noAuth.statusCode, 401, "sem token deve retornar 401");

    // Com token: deve retornar 200 com array
    const withAuth = await requestHttp({
      host: "127.0.0.1",
      port,
      path: "/admin/api/presets",
      method: "GET",
      headers: { "x-admin-token": token },
    });
    assert.equal(withAuth.statusCode, 200);
    assert.ok(Array.isArray(withAuth.body), "presets deve ser array");

    // Resposta não deve conter o token nem strings suspeitas de chave
    assert.ok(
      !withAuth.rawBody.includes("token-secreto-presets-xyz"),
      "resposta não deve conter o token admin",
    );
    assert.ok(
      !withAuth.rawBody.includes("apiKey"),
      "resposta não deve conter campo apiKey",
    );
  } finally {
    await new Promise((resolve) => srv.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv) process.env.CLAUDEZEN_CONFIG = originalEnv;
    else delete process.env.CLAUDEZEN_CONFIG;
    if (originalToken) process.env.CLAUDEZEN_ADMIN_TOKEN = originalToken;
    else delete process.env.CLAUDEZEN_ADMIN_TOKEN;
  }
});

/* ============================================================
   PASSO 6: ANÁLISE ESTÁTICA DOS ARQUIVOS admin/
   ============================================================ */

test("admin/ não contém innerHTML, outerHTML, insertAdjacentHTML nem eval", () => {
  const adminDir = path.join(__dirname, "..", "admin");
  const files = fs.readdirSync(adminDir).filter((f) => f.endsWith(".js"));

  const FORBIDDEN = [
    "innerHTML",
    "outerHTML",
    "insertAdjacentHTML",
    /\beval\s*\(/,
    "document.write",
  ];

  for (const file of files) {
    const content = fs.readFileSync(path.join(adminDir, file), "utf8");
    for (const pattern of FORBIDDEN) {
      if (typeof pattern === "string") {
        assert.ok(
          !content.includes(pattern),
          `${file} contém uso proibido de "${pattern}"`,
        );
      } else {
        assert.ok(
          !pattern.test(content),
          `${file} contém uso proibido de ${pattern}`,
        );
      }
    }
  }
});
