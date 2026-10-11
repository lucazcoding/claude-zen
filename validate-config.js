const VALIDATE_CONFIG_VERSION = "1.0.0";

/*
 * ============================================================
 * VALIDAÇÃO DA CONFIGURAÇÃO (CLAUDEZEN)
 * ============================================================
 *
 * Módulo central da validação do config.json. Usado na
 * inicialização para abortar (process.exit(1)) quando há erros
 * graves e para registrar avisos quando há inconsistências que
 * ainda permitem rodar.
 *
 * Convenção de entrada:
 *   validateConfig(config) onde config já é o objeto carregado
 *   do arquivo (com "routing", "providers", etc.).
 *
 * Convenção de saída:
 *   { errors: string[], warnings: string[] }
 *
 *   - errors  : devem ABORTAR a inicialização com mensagem clara
 *               (em português) e process.exit(1).
 *   - warnings: não abortam; apenas alertam no log de inicialização.
 *
 * Não escreve nenhuma chave de API em arquivo ou log.
 * ============================================================
 */

function validateConfig(config) {
  const errors = [];
  const warnings = [];

  const providers = config?.providers || {};
  const routing = config?.routing || {};

  const providerIds = Object.keys(providers);

  /* ---- providers vazio ou ausente (erro) ---- */
  if (!providerIds.length) {
    errors.push(
      "Nenhum provider configurado: o objeto \"providers\" está ausente ou vazio no config.json.",
    );
  }

  if (providerIds.length) {
    /* ---- validação por provider (erros) ---- */
    for (const id of providerIds) {
      const p = providers[id];

      if (!p || typeof p !== "object") {
        errors.push(
          `Provider "${id}": a entrada não é um objeto válido no config.json.`,
        );
        continue;
      }

      if (typeof p.baseUrl !== "string" || !p.baseUrl.trim()) {
        errors.push(
          `Provider "${id}": o campo "baseUrl" está ausente ou vazio.`,
        );
      }

      if (typeof p.model !== "string" || !p.model.trim()) {
        errors.push(
          `Provider "${id}": o campo "model" está ausente ou vazio.`,
        );
      }

      if (typeof p.apiKeyEnv !== "string" || !p.apiKeyEnv.trim()) {
        errors.push(
          `Provider "${id}": o campo "apiKeyEnv" está ausente ou vazio.`,
        );
      }
    }

    /* ---- fallbackOrder (erros + avisos) ---- */
    const fallback = routing.fallbackOrder;

    if (fallback !== undefined && fallback !== null) {
      if (!Array.isArray(fallback) || !fallback.length) {
        errors.push(
          "O campo \"routing.fallbackOrder\" deve ser uma lista não vazia de IDs de providers.",
        );
      } else {
        const seen = new Set();

        for (const id of fallback) {
          if (typeof id !== "string") {
            errors.push(
              `"routing.fallbackOrder" contém um elemento inválido (esperado um ID de provider como string): ${JSON.stringify(id)}.`,
            );
            continue;
          }

          if (!providers[id]) {
            errors.push(
              `"fallbackOrder" referencia o provider "${id}", que não existe em "providers".`,
            );
          }

          if (seen.has(id)) {
            warnings.push(
              `"fallbackOrder" contém o ID "${id}" mais de uma vez. Entradas duplicadas são ignoradas.`,
            );
          }

          seen.add(id);
        }
      }
    }

    /* ---- normalProvider / largeContextProvider (erros) ---- */
    const resolveRole = (value, label) => {
      if (value === undefined || value === null || value === "") {
        return;
      }

      if (typeof value !== "string") {
        errors.push(
          `"routing.${label}" deve ser um ID de provider (string), recebeu: ${JSON.stringify(value)}.`,
        );
        return;
      }

      if (!providers[value]) {
        errors.push(
          `"routing.${label}" aponta para o provider "${value}", que não existe em "providers".`,
        );
      }
    };

    resolveRole(routing.normalProvider, "normalProvider");
    resolveRole(routing.largeContextProvider, "largeContextProvider");

    /* ---- provider declarado mas fora do fallbackOrder (aviso) ---- */
    if (Array.isArray(fallback) && fallback.length) {
      for (const id of providerIds) {
        if (!fallback.includes(id)) {
          warnings.push(
            `Provider "${id}" está declarado em "providers", mas não aparece no "fallbackOrder". Ele será usado apenas em modo MANUAL.`,
          );
        }
      }
    }
  }

  return { errors, warnings };
}

module.exports = {
  VALIDATE_CONFIG_VERSION,
  validateConfig,
};