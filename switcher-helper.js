/*
 * ============================================================
 * SWITCHER HELPER (CLAUDEZEN)
 * ============================================================
 *
 * Auxiliar do switcher.bat. Lê o config.json e expõe, sem
 * dependências (apenas módulos nativos do Node):
 *
 *   node switcher-helper.js menu              -> linhas do menu
 *   node switcher-helper.js list              -> providers (id#nome)
 *   node switcher-helper.js resolve <opcao>   -> tipo#id da opção do menu
 *   node switcher-helper.js set <modo> [prov] -> grava routing-state.json
 *
 * O .bat NÃO parseia JSON em batch puro; delega a leitura para cá.
 *
 * Menus são construídos a partir dos providers do config.json:
 *   1 - AUTO
 *   2..N+1 - um provider por linha (na ordem de "providers")
 *   N+2 - STATUS
 *   0 - SAIR
 *
 * Nunca escreve chave de API em arquivo ou log.
 * ============================================================
 */

const fs = require("fs");
const path = require("path");

const BASE_DIR = __dirname;

/* ============================================================
 * CONFIG
 * ============================================================ */

function loadConfig() {
  const configPath =
    process.env.CLAUDEZEN_CONFIG ||
    path.join(BASE_DIR, "config.json");

  let parsed;

  try {
    parsed = JSON.parse(
      fs.readFileSync(configPath, "utf8"),
    );
  } catch (error) {
    return {
      error:
        "Não foi possível ler o config.json em " +
        configPath +
        " (" +
        error.message +
        "). Verifique se o arquivo existe e é um JSON válido.",
    };
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.providers !== "object" ||
    parsed.providers === null
  ) {
    return {
      error:
        "O config.json não contém o campo \"providers\" ou ele está vazio. Verifique a configuração.",
    };
  }

  return { config: parsed };
}

function providerEntries(config) {
  return Object.keys(config.providers).map((id) => ({
    id,
    name:
      config.providers[id]?.name ||
      id,
  }));
}

function routingStatePath(config) {
  if (config && config.routingStatePath) {
    const expanded = String(
      config.routingStatePath,
    ).replace(/^~\//, "");

    if (path.isAbsolute(expanded)) {
      return expanded;
    }

    return path.resolve(expanded);
  }

  return path.join(BASE_DIR, "routing-state.json");
}

/* ============================================================
 * MENU
 * ============================================================ */

function printMenu(config) {
  const entries = providerEntries(config);
  const optionCount = entries.length;

  console.log("1 - AUTO");

  entries.forEach((entry, index) => {
    console.log(
      `${index + 2} - ${entry.name} (${entry.id})`,
    );
  });

  console.log(`${optionCount + 2} - STATUS`);
  console.log("0 - SAIR");
}

function printList(config) {
  const entries = providerEntries(config);

  for (const entry of entries) {
    console.log(`${entry.id}#${entry.name}`);
  }
}

function resolveChoice(config, choice) {
  const entries = providerEntries(config);
  const optionCount = entries.length;
  const option = Number(choice);

  if (!Number.isInteger(option) || option < 0) {
    console.log("invalid#");
    return;
  }

  if (option === 0) {
    console.log("exit#");
    return;
  }

  if (option === 1) {
    console.log("auto#");
    return;
  }

  if (option === optionCount + 2) {
    console.log("status#");
    return;
  }

  const providerIndex = option - 2;

  if (
    providerIndex >= 0 &&
    providerIndex < entries.length
  ) {
    console.log(`manual#${entries[providerIndex].id}`);
    return;
  }

  console.log("invalid#");
}

/* ============================================================
 * SET STATE
 * ============================================================ */

function writeStateFile(statePath, payload) {
  const tmpPath = statePath + ".tmp";

  fs.writeFileSync(
    tmpPath,
    JSON.stringify(payload),
    "utf8",
  );

  fs.renameSync(tmpPath, statePath);
}

function setState(config, mode, providerId) {
  if (mode !== "auto" && mode !== "manual" && mode !== "custom") {
    console.error(
      "[switcher-helper] Modo inválido. Use 'auto', 'manual' ou 'custom'.",
    );
    process.exit(1);
  }

  if (mode === "manual") {
    if (!providerId) {
      console.error(
        "[switcher-helper] Modo manual requer um ID de provider.",
      );
      process.exit(1);
    }

    if (!config.providers[providerId]) {
      console.error(
        "[switcher-helper] Provider não existe no config.json: " +
          providerId,
      );
      console.error(
        "[switcher-helper] Providers disponíveis: " +
          Object.keys(config.providers).join(", "),
      );
      process.exit(1);
    }
  }

  const statePath = routingStatePath(config);

  try {
    writeStateFile(
      statePath,
      {
        mode,
        provider:
          mode === "manual" ? providerId : null,
      },
    );

    console.log(
      `OK: modo ${mode.toUpperCase()}` +
        (mode === "manual"
          ? " -> " + providerId
          : ""),
    );
  } catch (error) {
    console.error(
      "[switcher-helper] Falha ao gravar " +
        statePath +
        ": " +
        error.message,
    );
    process.exit(1);
  }
}

/* ============================================================
 * MAIN
 * ============================================================ */

function main() {
  const argv = process.argv.slice(2);
  const subcommand = argv[0];

  const loaded = loadConfig();

  if (loaded.error) {
    console.error("[switcher-helper] " + loaded.error);
    process.exit(1);
  }

  const config = loaded.config;

  if (subcommand === "menu") {
    printMenu(config);
    return;
  }

  if (subcommand === "list") {
    printList(config);
    return;
  }

  if (subcommand === "resolve") {
    resolveChoice(config, argv[1]);
    return;
  }

  if (subcommand === "set") {
    setState(config, argv[1], argv[2]);
    return;
  }

  console.error(
    "[switcher-helper] Comando desconhecido: " +
      (subcommand || "(vazio)"),
  );
  console.error(
    'Uso: node switcher-helper.js [menu|list|resolve <opcao>|set <modo> [provider]]',
  );
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadConfig,
  providerEntries,
  resolveChoice,
  printMenu,
  printList,
  setState,
};