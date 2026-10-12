const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const TMP = fs.mkdtempSync(
  path.join(os.tmpdir(), "claudezen-admin-test-"),
);

const CONFIG_PATH = path.join(TMP, "config.json");
const SECRETS_PATH = path.join(TMP, "secrets.json");
const BACKUPS_DIR = path.join(TMP, ".claudezen-backups");
const STATE_PATH = path.join(TMP, "routing-state.json");

const ADMIN_TOKEN = "test-admin-token-abc123";

process.env.CLAUDEZEN_CONFIG = CONFIG_PATH;
process.env.CLAUDEZEN_SECRETS_PATH = SECRETS_PATH;
process.env.CLAUDEZEN_ADMIN_TOKEN = ADMIN_TOKEN;
process.env.CLAUDEZEN_ROUTING_STATE = STATE_PATH;

const secretsStore = require("../secrets-store.js");

function baseConfig(mockPort) {
  return {
    listen: { host: "127.0.0.1", port: 8787 },
    routing: {
      mode: "auto",
      normalProvider: "alpha",
      largeContextProvider: "beta",
      largeContextThreshold: 1000,
      fallbackOrder: ["alpha", "beta"],
    },
    providers: {
      alpha: {
        name: "Alpha",
        baseUrl: `http://127.0.0.1:${mockPort}`,
        model: "alpha-model",
        apiKeyEnv: "ALPHA_KEY",
      },
      beta: {
        name: "Beta",
        baseUrl: `http://127.0.0.1:${mockPort}`,
        model: "beta-model",
        apiKeyEnv: "BETA_KEY",
      },
    },
  };
}

function writeConfig(cfg) {
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify(cfg, null, 2),
    "utf8",
  );
}

function loadServer() {
  delete require.cache[require.resolve("../server.js")];
  return require("../server.js");
}

function request(port, method, pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      "x-admin-token": opts.token !== undefined ? opts.token : ADMIN_TOKEN,
      ...(opts.headers || {}),
    };

    if (opts.body !== undefined && headers["content-type"] === undefined) {
      headers["content-type"] = "application/json";
    }

    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: pathname,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let body = data;
          try {
            body = JSON.parse(data);
          } catch {
            /* keep raw */
          }
          resolve({ status: res.statusCode, body, headers: res.headers });
        });
      },
    );

    req.on("error", reject);

    if (opts.body !== undefined) {
      req.write(
        typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
      );
    }

    req.end();
  });
}

function startMockUpstream(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      handler(req, res);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

let bridge;
let server;
let port;
let mockServer;
let mockPort;

test.before(async () => {
  mockServer = await startMockUpstream((req, res) => {
    if (
      (req.url === "/v1/chat/completions" ||
        req.url === "/chat/completions") &&
      req.method === "POST"
    ) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: Date.now(),
          model: "test",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  mockPort = mockServer.address().port;

  writeConfig(baseConfig(mockPort));

  bridge = loadServer();
  server = bridge.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (mockServer) await new Promise((r) => mockServer.close(r));
});

/* ---------- SEGURANÇA ---------- */

test("admin: token ausente retorna 401", async () => {
  const r = await request(port, "GET", "/admin/api/state", { token: "" });
  assert.equal(r.status, 401);
});

test("admin: token errado retorna 401", async () => {
  const r = await request(port, "GET", "/admin/api/state", { token: "wrong" });
  assert.equal(r.status, 401);
});

test("admin: Host inválido retorna 403", async () => {
  const r = await request(port, "GET", "/admin/api/state", {
    headers: { host: "evil.com:8787" },
  });
  assert.equal(r.status, 403);
});

test("admin: Origin diferente em POST retorna 403", async () => {
  const r = await request(port, "POST", "/admin/api/reload", {
    headers: { origin: "http://evil.com" },
  });
  assert.equal(r.status, 403);
});

test("admin: Origin igual ao servidor é aceito", async () => {
  const r = await request(port, "POST", "/admin/api/reload", {
    headers: { origin: `http://127.0.0.1:${port}` },
  });
  assert.equal(r.status, 200);
});

/* ---------- STATE ---------- */

test("admin: GET /state retorna providers sem chave, com keySource", async () => {
  const r = await request(port, "GET", "/admin/api/state");
  assert.equal(r.status, 200);
  assert.ok(r.body.providers.alpha);
  assert.ok(r.body.providers.beta);
  assert.equal(r.body.providers.alpha.id, "alpha");
  assert.equal(r.body.providers.alpha.hasKey, false);
  assert.equal(r.body.providers.alpha.keySource, "missing");
  assert.equal(r.body.providers.alpha.apiKey, undefined);
});

/* ---------- CRUD PROVIDERS ---------- */

test("admin: criar provider válido retorna 201 e adiciona ao fallback", async () => {
  const r = await request(port, "POST", "/admin/api/providers", {
    body: {
      id: "gamma",
      name: "Gamma",
      baseUrl: `http://127.0.0.1:${mockPort}`,
      model: "gamma-model",
      apiKey: "sk-gamma-1234",
    },
  });
  assert.equal(r.status, 201);

  const state = await request(port, "GET", "/admin/api/state");
  assert.ok(state.body.providers.gamma);
  assert.ok(state.body.fallbackOrder.includes("gamma"));
  assert.equal(state.body.providers.gamma.hasKey, true);
  assert.equal(state.body.providers.gamma.keySource, "stored");
  assert.equal(state.body.providers.gamma.keyLast4, "1234");
});

test("admin: criar provider com ID duplicado retorna 409", async () => {
  const r = await request(port, "POST", "/admin/api/providers", {
    body: {
      id: "gamma",
      name: "Gamma 2",
      baseUrl: `http://127.0.0.1:${mockPort}`,
      model: "gamma-model-2",
    },
  });
  assert.equal(r.status, 409);
});

test("admin: provider criado via API gera apiKeyEnv automaticamente", async () => {
  const state = await request(port, "GET", "/admin/api/state");
  assert.equal(state.body.providers.gamma.apiKeyEnv, "CLAUDEZEN_GAMMA_API_KEY");
});

test("admin: chave sentinela nunca aparece em resposta", async () => {
  const sentinel = "SENTINEL-KEY-9999";
  const r = await request(port, "POST", "/admin/api/providers", {
    body: {
      id: "delta",
      name: "Delta",
      baseUrl: `http://127.0.0.1:${mockPort}`,
      model: "delta-model",
      apiKey: sentinel,
    },
  });
  assert.equal(r.status, 201);

  const state = await request(port, "GET", "/admin/api/state");
  const serialized = JSON.stringify(state.body);
  assert.ok(!serialized.includes(sentinel));
  assert.equal(state.body.providers.delta.keyLast4, "9999");
});

test("admin: editar provider sem apiKey mantém a chave atual", async () => {
  const r = await request(port, "PUT", "/admin/api/providers/gamma", {
    body: { name: "Gamma Renomeado" },
  });
  assert.equal(r.status, 200);

  const state = await request(port, "GET", "/admin/api/state");
  assert.equal(state.body.providers.gamma.name, "Gamma Renomeado");
  assert.equal(state.body.providers.gamma.hasKey, true);
  assert.equal(state.body.providers.gamma.keySource, "stored");
  assert.equal(state.body.providers.gamma.keyLast4, "1234");
});

test("admin: editar provider com apiKey vazia mantém a chave atual", async () => {
  const r = await request(port, "PUT", "/admin/api/providers/gamma", {
    body: { name: "Gamma 3", apiKey: "" },
  });
  assert.equal(r.status, 200);

  const state = await request(port, "GET", "/admin/api/state");
  assert.equal(state.body.providers.gamma.keyLast4, "1234");
});

test("admin: PUT /key/:id atualiza só a chave", async () => {
  const r = await request(port, "PUT", "/admin/api/key/gamma", {
    body: { apiKey: "nova-chave-5678" },
  });
  assert.equal(r.status, 200);

  const state = await request(port, "GET", "/admin/api/state");
  assert.equal(state.body.providers.gamma.keyLast4, "5678");
});

test("admin: DELETE /key/:id remove chave guardada", async () => {
  const r = await request(port, "DELETE", "/admin/api/key/gamma");
  assert.equal(r.status, 200);

  const state = await request(port, "GET", "/admin/api/state");
  assert.equal(state.body.providers.gamma.hasKey, false);
  assert.equal(state.body.providers.gamma.keySource, "missing");
});

test("admin: keySource reflete variável de ambiente quando não há chave guardada", async () => {
  process.env.ALPHA_KEY = "env-alpha-abcd";
  const state = await request(port, "GET", "/admin/api/state");
  assert.equal(state.body.providers.alpha.keySource, "env");
  assert.equal(state.body.providers.alpha.keyLast4, "abcd");
  delete process.env.ALPHA_KEY;
});

test("admin: chave guardada tem prioridade sobre variável de ambiente", async () => {
  process.env.BETA_KEY = "env-beta-1111";
  await request(port, "PUT", "/admin/api/key/beta", {
    body: { apiKey: "stored-beta-2222" },
  });

  const state = await request(port, "GET", "/admin/api/state");
  assert.equal(state.body.providers.beta.keySource, "stored");
  assert.equal(state.body.providers.beta.keyLast4, "2222");

  await request(port, "DELETE", "/admin/api/key/beta");
  delete process.env.BETA_KEY;
});

/* ---------- CONFIG INVÁLIDO ---------- */

test("admin: config inválido retorna 422 e não altera o arquivo", async () => {
  const before = fs.readFileSync(CONFIG_PATH, "utf8");

  const r = await request(port, "PUT", "/admin/api/providers/alpha", {
    body: { model: "" },
  });
  assert.equal(r.status, 422);

  const after = fs.readFileSync(CONFIG_PATH, "utf8");
  assert.equal(after, before);
});

/* ---------- FALLBACK ORDER ---------- */

test("admin: reordenar fallback reflete no estado", async () => {
  const r = await request(port, "PUT", "/admin/api/order", {
    body: { fallbackOrder: ["beta", "alpha", "gamma"] },
  });
  assert.equal(r.status, 200);

  const state = await request(port, "GET", "/admin/api/state");
  assert.deepEqual(state.body.fallbackOrder, ["beta", "alpha", "gamma"]);
});

test("admin: ordem com ID inexistente retorna 400", async () => {
  const r = await request(port, "PUT", "/admin/api/order", {
    body: { fallbackOrder: ["alpha", "inexistente"] },
  });
  assert.equal(r.status, 400);
});

test("admin: ordem com duplicado retorna 400", async () => {
  const r = await request(port, "PUT", "/admin/api/order", {
    body: { fallbackOrder: ["alpha", "alpha"] },
  });
  assert.equal(r.status, 400);
});

/* ---------- ROUTING ---------- */

test("admin: PUT /routing atualiza normal/large/threshold", async () => {
  const r = await request(port, "PUT", "/admin/api/routing", {
    body: {
      normalProvider: "beta",
      largeContextProvider: "alpha",
      largeContextThreshold: 5000,
    },
  });
  assert.equal(r.status, 200);

  const state = await request(port, "GET", "/admin/api/state");
  assert.equal(state.body.normalProvider, "beta");
  assert.equal(state.body.largeContextProvider, "alpha");
  assert.equal(state.body.largeContextThreshold, 5000);
});

/* ---------- MODE ---------- */

test("admin: PUT /mode manual", async () => {
  const r = await request(port, "PUT", "/admin/api/mode", {
    body: { mode: "manual", provider: "alpha" },
  });
  assert.equal(r.status, 200);

  const state = await request(port, "GET", "/admin/api/state");
  assert.equal(state.body.mode, "manual");
  assert.equal(state.body.manualProvider, "alpha");
});

test("admin: PUT /mode auto", async () => {
  const r = await request(port, "PUT", "/admin/api/mode", {
    body: { mode: "auto" },
  });
  assert.equal(r.status, 200);

  const state = await request(port, "GET", "/admin/api/state");
  assert.equal(state.body.mode, "auto");
});

/* ---------- DELETE PROVIDER ---------- */

test("admin: deletar provider em uso (normalProvider) retorna 409", async () => {
  await request(port, "PUT", "/admin/api/routing", {
    body: { normalProvider: "alpha" },
  });

  const r = await request(port, "DELETE", "/admin/api/providers/alpha");
  assert.equal(r.status, 409);
});

test("admin: deletar provider livre remove do config e da secrets", async () => {
  await request(port, "PUT", "/admin/api/key/delta", {
    body: { apiKey: "delta-key-9999" },
  });

  const r = await request(port, "DELETE", "/admin/api/providers/delta");
  assert.equal(r.status, 200);

  const state = await request(port, "GET", "/admin/api/state");
  assert.equal(state.body.providers.delta, undefined);
  assert.equal(secretsStore.hasSecret("delta"), false);
});

/* ---------- RELOAD E COOLDOWN ---------- */

test("admin: reload mantém cooldown por ID de provider", async () => {
  const router = bridge.getRouter();
  const stats = router.getStats();
  const now = Date.now();
  stats.set("alpha", { cooldownUntil: now + 999999, requests: 5 });

  await request(port, "POST", "/admin/api/reload");

  const router2 = bridge.getRouter();
  const stats2 = router2.getStats();
  const alpha = stats2.get("alpha");
  assert.ok(alpha);
  assert.ok(alpha.cooldownUntil > now);
  assert.equal(alpha.requests, 5);
});

/* ---------- BACKUPS ---------- */

test("admin: backup é criado ao salvar config e limitado a 10", async () => {
  for (let i = 0; i < 12; i++) {
    await request(port, "PUT", "/admin/api/routing", {
      body: { largeContextThreshold: 1000 + i },
    });
  }

  const files = fs
    .readdirSync(BACKUPS_DIR)
    .filter((f) => f.startsWith("config-") && f.endsWith(".json"));

  assert.ok(files.length >= 1);
  assert.ok(files.length <= 10);
});

/* ---------- TESTE DE CONEXÃO ---------- */

test("admin: teste de conexão com upstream 200 retorna ok", async () => {
  await request(port, "PUT", "/admin/api/key/alpha", {
    body: { apiKey: "alpha-conn-key" },
  });

  const r = await request(port, "POST", "/admin/api/providers/alpha/test");
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.status, 200);
  assert.ok(typeof r.body.latencyMs === "number");
  assert.ok(!JSON.stringify(r.body).includes("alpha-conn-key"));
});

test("admin: teste de conexão com upstream 503 retorna ok:false", async () => {
  const failServer = http.createServer((req, res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "down" } }));
  });
  await new Promise((r) => failServer.listen(0, "127.0.0.1", r));
  const failPort = failServer.address().port;

  try {
    await request(port, "PUT", "/admin/api/providers/beta", {
      body: { baseUrl: `http://127.0.0.1:${failPort}` },
    });
    await request(port, "PUT", "/admin/api/key/beta", {
      body: { apiKey: "beta-fail-key" },
    });

    const r = await request(port, "POST", "/admin/api/providers/beta/test");
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.status, 503);
  } finally {
    await new Promise((r) => failServer.close(r));
  }
});
