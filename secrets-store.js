const fs = require("fs");
const os = require("os");
const path = require("path");

/* ============================================================
 * SECRETS STORE (CLAUDEZEN)
 * ============================================================
 *
 * Armazena chaves de API dos providers em um arquivo JSON
 * fora do repositório: ~/.claudezen/secrets.json
 *
 * Formato: { "<providerId>": "<chave>" }
 *
 * Regras:
 *   - Escrita atômica (tmp + rename)
 *   - Permissões restritas ao usuário (melhor esforço)
 *   - NUNCA retorna a chave em log ou resposta HTTP
 *   - Caminho pode ser sobrescrito via env CLAUDEZEN_SECRETS_PATH
 *     (usado pelos testes)
 * ============================================================ */

let secretsPath =
  process.env.CLAUDEZEN_SECRETS_PATH ||
  path.join(os.homedir(), ".claudezen", "secrets.json");

function setSecretsPath(p) {
  secretsPath = p;
}

function getSecretsPath() {
  return secretsPath;
}

function ensureDir() {
  try {
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
  } catch {
    /* ignore */
  }
}

function readSecrets() {
  try {
    const raw = fs.readFileSync(secretsPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function writeSecretsAtomic(data) {
  ensureDir();
  const tmp = `${secretsPath}.tmp.${process.pid}`;

  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");

  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* Windows pode não suportar chmod 0600; ignora */
  }

  fs.renameSync(tmp, secretsPath);
}

function getSecret(providerId) {
  if (!providerId) return null;
  const all = readSecrets();
  const value = all[providerId];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function setSecret(providerId, key) {
  if (!providerId || typeof key !== "string") return;
  const all = readSecrets();
  all[providerId] = key;
  writeSecretsAtomic(all);
}

function deleteSecret(providerId) {
  if (!providerId) return;
  const all = readSecrets();
  if (providerId in all) {
    delete all[providerId];
    writeSecretsAtomic(all);
  }
}

function hasSecret(providerId) {
  return Boolean(getSecret(providerId));
}

function keyLast4(key) {
  if (!key || typeof key !== "string" || key.length < 4) return null;
  return key.slice(-4);
}

module.exports = {
  setSecretsPath,
  getSecretsPath,
  readSecrets,
  getSecret,
  setSecret,
  deleteSecret,
  hasSecret,
  keyLast4,
  get: getSecret,
  set: setSecret,
  delete: deleteSecret,
  has: hasSecret,
};
