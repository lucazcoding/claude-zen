const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const TMP = fs.mkdtempSync(
  path.join(os.tmpdir(), "claudezen-admin-ui-test-"),
);

const CONFIG_PATH = path.join(TMP, "config.json");
const SECRETS_PATH = path.join(TMP, "secrets.json");
const STATE_PATH = path.join(TMP, "routing-state.json");

const ADMIN_TOKEN = "test-admin-token-ui-xyz";

process.env.CLAUDEZEN_CONFIG = CONFIG_PATH;
process.env.CLAUDEZEN_SECRETS_PATH = SECRETS_PATH;
process.env.CLAUDEZEN_ADMIN_TOKEN = ADMIN_TOKEN;
process.env.CLAUDEZEN_ROUTING_STATE = STATE_PATH;

const ADMIN_DIR = path.join(__dirname, "..", "admin");

function writeConfig() {
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify(
      {
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
            baseUrl: "http://127.0.0.1:9999",
            model: "alpha-model",
            apiKeyEnv: "ALPHA_KEY",
          },
          beta: {
            name: "Beta",
            baseUrl: "http://127.0.0.1:9999",
            model: "beta-model",
            apiKeyEnv: "BETA_KEY",
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

function loadServer() {
  delete require.cache[require.resolve("../server.js")];
  return require("../server.js");
}

function request(method, pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...(opts.headers || {}) };
    const req = http.request(
      {
        host: "127.0.0.1",
        port: opts.port,
        method,
        path: pathname,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          resolve({ status: res.statusCode, body: data, headers: res.headers });
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

let bridge;
let server;
let port;

test.before(async () => {
  writeConfig();
  bridge = loadServer();
  server = bridge.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  fs.rmSync(TMP, { recursive: true, force: true });
});

const EXPECTED_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none';";

/* ---------- Entrega da página e headers ---------- */

const staticCases = [
  { path: "/admin", file: "index.html", type: "text/html; charset=utf-8" },
  { path: "/admin/", file: "index.html", type: "text/html; charset=utf-8" },
  { path: "/admin/admin.css", file: "admin.css", type: "text/css; charset=utf-8" },
  { path: "/admin/admin.js", file: "admin.js", type: "text/javascript; charset=utf-8" },
];

for (const c of staticCases) {
  test(`admin-ui: GET ${c.path} retorna 200 com headers corretos`, async () => {
    const r = await request("GET", c.path, { port });
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-type"], c.type);
    assert.equal(r.headers["content-security-policy"], EXPECTED_CSP);
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.headers["referrer-policy"], "no-referrer");
    assert.equal(r.headers["cache-control"], "no-store");
    const expected = fs.readFileSync(
      path.join(ADMIN_DIR, c.file),
      "utf8",
    );
    assert.equal(r.body, expected);
  });
}

test("admin-ui: página não exige token", async () => {
  const r = await request("GET", "/admin", { port, headers: {} });
  assert.equal(r.status, 200);
});

/* ---------- Host check ---------- */

test("admin-ui: Host inválido em /admin retorna 403", async () => {
  const r = await request("GET", "/admin", {
    port,
    headers: { host: "evil.com:8787" },
  });
  assert.equal(r.status, 403);
});

/* ---------- Path traversal e caminhos não permitidos ---------- */

const badPaths = [
  "/admin/../server.js",
  "/admin/%2e%2e/server.js",
  "/admin//admin.js",
  "/admin/qualquer",
  "/admin/server.js",
  "/admin/../package.json",
  "/admin/index.html",
];

for (const p of badPaths) {
  test(`admin-ui: caminho proibido ${p} retorna 404`, async () => {
    const r = await request("GET", p, { port });
    assert.equal(r.status, 404);
    assert.ok(
      !r.body.includes("createServer") && !r.body.includes("module.exports"),
      "não deve vazar conteúdo de server.js",
    );
  });
}

/* ---------- Análise estática ---------- */

function readAdmin(name) {
  return fs.readFileSync(path.join(ADMIN_DIR, name), "utf8");
}

test("admin-ui: index.html sem script inline, style inline nem on* inline", () => {
  const html = readAdmin("index.html");
  assert.ok(
    !/<script(?![^>]*src=)[^>]*>/i.test(html),
    "nenhum <script> sem src (inline)",
  );
  assert.ok(
    !/\sstyle\s*=/.test(html),
    "nenhum atributo style=",
  );
  assert.ok(
    !/\son\w+\s*=/.test(html),
    "nenhum atributo on*=",
  );
});

test("admin-ui: index.html sem URLs externas em src/href", () => {
  const html = readAdmin("index.html");
  const urlAttrs = html.match(/(?:src|href)\s*=\s*"([^"]*)"/gi) || [];
  for (const m of urlAttrs) {
    const val = m.match(/"([^"]*)"/)[1];
    assert.ok(
      !/^https?:\/\//i.test(val) || val.startsWith("/admin/"),
      `URL externa não permitida: ${val}`,
    );
  }
});

test("admin-ui: admin.css sem recursos externos (url externa)", () => {
  const css = readAdmin("admin.css");
  assert.ok(
    !/url\(\s*['"]?https?:\/\//i.test(css),
    "nenhum url() com http/https",
  );
});

test("admin-ui: admin.js sem innerHTML/outerHTML/insertAdjacentHTML/document.write/eval/new Function", () => {
  const js = readAdmin("admin.js");
  const forbidden = [
    "innerHTML",
    "outerHTML",
    "insertAdjacentHTML",
    "document.write",
    "eval(",
    "new Function",
  ];
  for (const f of forbidden) {
    assert.ok(
      js.indexOf(f) === -1,
      `proibido encontrado em admin.js: ${f}`,
    );
  }
});

test("admin-ui: admin.js cria elementos via createElement e textContent", () => {
  const js = readAdmin("admin.js");
  assert.ok(js.includes("createElement"));
  assert.ok(js.includes("textContent"));
});

/* ---------- Regressão: /v1 e /router/status ---------- */

test("admin-ui: /router/status continua respondendo", async () => {
  const r = await request("GET", "/router/status", { port });
  assert.equal(r.status, 200);
  let body;
  try {
    body = JSON.parse(r.body);
  } catch (e) {
    assert.fail("resposta não é JSON");
  }
  assert.ok("mode" in body);
  assert.ok("providers" in body || Array.isArray(body));
});

test("admin-ui: /v1/messages responde como antes (regressão)", async () => {
  const r = await request("POST", "/v1/messages", {
    port,
    headers: { "content-type": "application/json" },
    body: "{invalid-json",
  });
  assert.equal(r.status, 400);
});

/* ---------- Ciclo completo da interface com upstream simulado (Passo 4) ---------- */

test("admin-ui: ciclo completo da interface (estado, criar com upstream, testar, reordenar, modo, excluir)", async () => {
  // 1. Mock upstream HTTP
  let mockHits = 0;
  const mockServer = http.createServer((req, res) => {
    if (req.url.endsWith("/chat/completions") && req.method === "POST") {
      mockHits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-test",
          choices: [{ message: { role: "assistant", content: "pong" } }],
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => mockServer.listen(0, "127.0.0.1", r));
  const mockPort = mockServer.address().port;

  try {
    const adminHeaders = {
      "x-admin-token": ADMIN_TOKEN,
      origin: `http://127.0.0.1:${port}`,
      "content-type": "application/json",
    };

    // 2. Ler estado inicial
    const state0 = await request("GET", "/admin/api/state", {
      port,
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    assert.equal(state0.status, 200);
    const parsedState0 = JSON.parse(state0.body);
    assert.ok(parsedState0.providers.alpha);

    // 3. Criar provider com upstream simulado
    const createRes = await request("POST", "/admin/api/providers", {
      port,
      headers: adminHeaders,
      body: {
        id: "mock-prov",
        name: "Mock Provider",
        baseUrl: `http://127.0.0.1:${mockPort}`,
        model: "mock-model",
        apiKey: "super-secret-key-1234",
      },
    });
    assert.equal(createRes.status, 201);

    // 4. Testar conexão do provider recém-criado
    const testRes = await request(
      "POST",
      "/admin/api/providers/mock-prov/test",
      {
        port,
        headers: adminHeaders,
      },
    );
    assert.equal(testRes.status, 200);
    const testBody = JSON.parse(testRes.body);
    assert.equal(testBody.ok, true);
    assert.equal(testBody.status, 200);
    assert.ok(mockHits >= 1);

    // 5. Reordenar fallback order
    const orderRes = await request("PUT", "/admin/api/order", {
      port,
      headers: adminHeaders,
      body: {
        fallbackOrder: ["mock-prov", "alpha", "beta"],
      },
    });
    assert.equal(orderRes.status, 200);
    const orderBody = JSON.parse(orderRes.body);
    assert.deepEqual(orderBody.fallbackOrder, ["mock-prov", "alpha", "beta"]);

    // 6. Alternar modo para MANUAL com o novo provider
    const manualRes = await request("PUT", "/admin/api/mode", {
      port,
      headers: adminHeaders,
      body: {
        mode: "manual",
        provider: "mock-prov",
      },
    });
    assert.equal(manualRes.status, 200);
    const manualBody = JSON.parse(manualRes.body);
    assert.equal(manualBody.mode, "manual");
    assert.equal(manualBody.provider, "mock-prov");

    // 7. Alternar de volta para AUTO
    const autoRes = await request("PUT", "/admin/api/mode", {
      port,
      headers: adminHeaders,
      body: {
        mode: "auto",
      },
    });
    assert.equal(autoRes.status, 200);
    const autoBody = JSON.parse(autoRes.body);
    assert.equal(autoBody.mode, "auto");

    // 8. Excluir o provider de teste
    const delRes = await request("DELETE", "/admin/api/providers/mock-prov", {
      port,
      headers: adminHeaders,
    });
    assert.equal(delRes.status, 200);

    // 9. Verificar estado final
    const stateFinal = await request("GET", "/admin/api/state", {
      port,
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    const parsedFinal = JSON.parse(stateFinal.body);
    assert.equal(parsedFinal.providers["mock-prov"], undefined);
    assert.ok(!parsedFinal.fallbackOrder.includes("mock-prov"));
  } finally {
    await new Promise((r) => mockServer.close(r));
  }
});

