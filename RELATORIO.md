# ClaudeZen Hybrid Router

## Relatório Técnico de Arquitetura, Implementação e Operação

**Projeto:** ClaudeZen
**Ambiente:** Windows
**Runtime:** Node.js
**Arquitetura:** Proxy local + Router multi-provider
**Porta local:** `127.0.0.1:8787`
**Dependências adicionais:** nenhuma
**Última atualização:** 12/10/2026
**Status:** Operacional e **em desenvolvimento ativo**. Fallback em cadeia validado em ambiente simulado. A **configuração genérica para múltiplos providers por plataforma** foi implementada e testada (dois modelos do OpenRouter como providers independentes), com validação da configuração na inicialização, menu dinâmico no switcher, painel web administrativo `/admin` com abas horizontais, modo `CUSTOM` (fallback manual por ordem direta) e **100 testes automatizados** passando via `node --test`. Permanece pendente o **teste com falha real de provedor** (429/5xx reais). Ver [seção 20](#20-pontos-a-melhorar-em-desenvolvimento).

---

# 1. Visão geral

O ClaudeZen foi adaptado de um proxy que encaminhava as requisições para um único upstream para uma arquitetura de roteamento híbrido com múltiplos provedores.

A arquitetura atual permite:

* utilização automática do APInex para tarefas normais;
* utilização automática do Gemini para contextos grandes;
* fallback automático entre provedores em cadeia;
* seleção manual de um provider (`MANUAL`);
* roteamento estrito pela ordem de contingência ignorando regras de contexto (`CUSTOM`);
* cooldown temporário de providers que apresentaram falhas;
* **streaming em tempo real**, com cancelamento propagado ao upstream;
* **observabilidade por requisição**: contexto, tools, roteamento, uso real informado pelo provedor e tempo;
* painel visual administrativo em `/admin` e API local em `/admin/api`;
* monitoramento via endpoint `/router/status`;
* operação sem dependências externas adicionais (zero npm em produção);
* preservação da configuração existente do Claude Code.

```text
┌─────────────────────────────────────────────────────────┐
│                       CLAUDE CODE                       │
│ model configurado: qwen/qwen3.8-27b:free               │
│ base URL: http://127.0.0.1:8787                        │
└─────────────────────────────┬───────────────────────────┘
                              │ HTTP
                              ▼
┌─────────────────────────────────────────────────────────┐
│                    CLAUDEZEN PROXY (server.js)          │
│  Conversão Anthropic/OpenAI · Streaming · Reasoning     │
│  cache · Observabilidade (apresentação dos logs)        │
│  Painel /admin · API /admin/api · Hot reload config     │
└─────────────────────────────┬───────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────┐
│                    REQUEST ROUTER (router.js)           │
│  Estimativa de contexto · AUTO / MANUAL / CUSTOM        │
│  Fallback · Timeout · Cooldown · Métricas de sessão     │
└──────────────────────────────┬──────────────────────────┘
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
       ┌────────────┐   ┌────────────┐   ┌────────────┐
       │   APInex   │   │   Gemini   │   │ OpenRouter │
       │ Principal  │   │ Ctx grande │   │  Reserva   │
       └────────────┘   └────────────┘   └────────────┘
```

---

# 2. Objetivo da arquitetura

A finalidade não é apenas distribuir requisições, mas criar uma **camada de abstração** entre o Claude Code e os provedores externos. O Claude Code sempre conversa com `http://127.0.0.1:8787`; o ClaudeZen decide:

```text
Qual provider?   Qual modelo?   Está disponível?
Está em cooldown?   O contexto é grande?   O anterior falhou?
```

---

# 3. Providers configurados

| Provider          | Base URL                                                   | Modelo                    | Função                     |
| ----------------- | ---------------------------------------------------------- | ------------------------- | -------------------------- |
| **APInex**        | `https://api.apinex.bond/v1`                               | `free/mimo-v2.6-pro`      | Principal (contexto < 100k) |
| **Google Gemini** | `https://generativelanguage.googleapis.com/v1beta/openai`  | `gemini-3.8-flash`        | Contexto grande (≥ 100k) e 1º fallback |
| **OpenRouter Qwen**    | `https://openrouter.ai/api/v1`                         | `qwen/qwen3.8-27b:free`   | Contingência (3º)           |
| **OpenRouter Laguna**  | `https://openrouter.ai/api/v1`                         | `poolside/laguna-s-2.1:free` | Última contingência (4º) |

> **Nota:** dois providers do OpenRouter compartilham o mesmo `baseUrl`, mas são entidades independentes (cada um com `model`, `apiKeyEnv`, `name` e posição própria no `fallbackOrder`). O router os identifica pelo **ID** (`providers[id]`), não pela URL. Isso permite usar vários modelos da mesma plataforma como contingências separadas. Detalhes na [seção 20.1](#201-configuração-genérica-para-múltiplos-modelos-da-mesma-plataforma).

## 3.1 Como adicionar um provider

O princípio de design é simples: **providers são identificados por ID, não por URL**. Cada entrada em `providers` é uma entidade independente.

- **Campos obrigatórios** (validados em `validate-config.js`, abortam a inicialização se ausentes): `baseUrl`, `model`, `apiKeyEnv`.
- **Campos opcionais:** `name` (exibição), `timeoutMs` (padrão 600000ms ou `upstreamTimeoutMs`), `headers` (objeto com headers customizados).
- **Roteamento:** `normalProvider` e `largeContextProvider` derivam do primeiro e segundo provider (respectivamente) se não definidos explicitamente. O `fallbackOrder` define a ordem de contingência; um provider fora dessa lista só é usado em modo MANUAL (com aviso na inicialização).
- **Validação:** ocorre na inicialização via `validate-config.js` — erros abortam com `process.exit(1)`, avisos apenas alertam.
- **Chave ausente:** o banner mostra `○` com aviso; a requisição falha em runtime com status 500 (`configuration_error`).

Guia passo a passo completo (template, exemplo, erros comuns e checklist) no README: [Como adicionar um novo provider ou modelo](README.md#como-adicionar-um-novo-provider-ou-modelo).

---

# 4. Arquitetura de arquivos

```text
C:\AI_config\ClaudeZen\
├── server.js
├── router.js
├── secrets-store.js
├── validate-config.js
├── config.json
├── switcher.bat
├── routing-state.json
├── admin/
│   ├── index.html
│   ├── admin.css
│   └── admin.js
├── test/
│   ├── server.test.js
│   ├── generic-providers.test.js
│   ├── admin-api.test.js
│   └── admin-ui.test.js
├── server.backup.js
└── config.backup.json
```

## Princípio de responsabilidades

> **O router calcula. O server apresenta.**

### `router.js`

* analisar o payload e **estimar** o contexto (bytes ÷ 4);
* separar a estimativa em `system`, `messages`, `tools` e `other`;
* escolher o provider (AUTO/MANUAL/CUSTOM), aplicar cooldown e fallback;
* aplicar timeout por provider;
* manter métricas de sessão e por provider;
* devolver em `call()` o objeto da requisição (`response`, `provider`, `model`, `contextTokens`, `context`, `routeReason`, `mode`, `fallbackCount`, `skipped`, `observability`);
* expor `recordUsage()` para registrar o usage de streams.

### `server.js`

* servidor HTTP e infraestrutura original do ClaudeZen;
* conversão Anthropic ↔ OpenAI e streaming;
* rotas do painel web `/admin` e API administrativa `/admin/api`;
* **apresentar** o bloco de observabilidade, o banner e o resumo de sessão;
* ler o `usage` real do upstream e compará-lo com a estimativa do router.

### `config.json` e `routing-state.json`

`config.json` contém a configuração declarativa (providers e regras). `routing-state.json` representa a escolha operacional do usuário e é lido a cada requisição:

```json
{ "mode": "auto",   "provider": null }
{ "mode": "custom", "provider": null }
{ "mode": "manual", "provider": "gemini" }
```

### `switcher.bat`

```text
1 - AUTO     2 - APInex     3 - Google Gemini
4 - OpenRouter Qwen         5 - OpenRouter Laguna
6 - STATUS                  0 - SAIR
```

Trocar o modo pelo switcher ou pela interface `/admin` não exige reiniciar o servidor.

---

# 5. Fluxo de uma requisição

```text
Claude Code
     │  POST /v1/messages (stream)
     ▼
server.js ── Anthropic → OpenAI
     │
     ▼
router.js ── analisa contexto ── escolhe modo/provider ── cooldown
     │
     ▼
Provider externo ── 200 (stream) ──┐
     │                             │ chunks repassados em tempo real
     ▼                             ▼
server.js ── OpenAI → Anthropic ── Claude Code
     │
     └─ no fim do stream: usage real → bloco de observabilidade
                                      → router.recordUsage()
```

---

# 6. Roteamento automático

```text
              AUTO
                │
       ┌────────┴────────┐
    < 100k             >= 100k
       ▼                 ▼
    APInex             Gemini
```

Ordem de fallback: `APInex → Gemini → OpenRouter`.

---

# 7. Estimativa de contexto

## 7.1 Método

```text
tokens ≈ bytes / 4
```

Não reproduz o tokenizer de nenhum modelo. Existe para (a) classificar a requisição como `NORMAL_CONTEXT` ou `LARGE_CONTEXT` e (b) alimentar a observabilidade. O limite de `100.000` é um threshold operacional aproximado.

## 7.2 Precisão medida

Em uma requisição real ("oi" no Claude Code) com o APInex:

| Medida                       | Valor        |
| ---------------------------- | ------------ |
| Estimativa local             | 22.194       |
| Input informado pelo upstream | 22.457      |
| Diferença                    | +263 (≈ 1,2%) |

A estimativa fica pouco abaixo do real, o que é aceitável para o objetivo de classificação.

## 7.3 Divisão por categoria

Na mesma requisição:

| Categoria  | Tokens estimados |
| ---------- | ---------------- |
| System     | ~6.237           |
| Messages   | ~347             |
| Tools (25) | ~15.579          |
| Other      | ~31              |
| **Soma**   | **22.194**       |

Observação: no formato OpenAI o system prompt vem dentro de `messages`. O router separa as mensagens de role `system`/`developer` para que a categoria System reflita a realidade. A categoria `Other` é calculada como **resto exato**, de modo que a soma das partes sempre fecha com o total.

---

# 8. Fallback automático

Status recuperáveis: `408`, `425`, `429`, `500-599`.
Erros de rede recuperáveis: `ETIMEDOUT`, `ECONNRESET`, `ECONNREFUSED`, `ECONNABORTED`, `ENOTFOUND`, `EAI_AGAIN`.

Demais erros (por exemplo `400`) **não** acionam fallback: são devolvidos ao cliente.

```text
APInex ── erro recuperável ──▶ Gemini ── erro recuperável ──▶ OpenRouter
```

Avisos exibidos (sempre, mesmo sem modo verbose):

```text
⚠️  APInex falhou (503) — acionando fallback
🧊 APInex em cooldown por 300s
⏭️  APInex pulado (em cooldown)
```

---

# 9. Cooldown

Após uma falha recuperável o provider entra em cooldown de **300 s** (5 min). No modo AUTO ele é pulado durante esse período.

---

# 10. Modos de Operação: AUTO × CUSTOM × MANUAL

O ClaudeZen implementa três regras de negócio distintas para resolução do provider inicial:

| Modo | Quem decide | Avalia tokens/contexto? | Cooldown | Ordem de tentativa |
| ---- | ----------- | ----------------------- | -------- | ------------------ |
| **`AUTO`** | O router | Sim (`< 100k` vs `≥ 100k`) | Respeitado (pula em cooldown) | `normalProvider` (ou `largeContextProvider`) seguido do `fallbackOrder` |
| **`CUSTOM`** | Ordem de Fallback | **Não** (ignora volume de tokens) | Respeitado (pula em cooldown) | `fallbackOrder[0] → fallbackOrder[1] → fallbackOrder[2]...` |
| **`MANUAL`** | O operador | **Não** (ignora volume de tokens) | **Ignorado** para o escolhido | Provider escolhido sempre primeiro, seguido do `fallbackOrder` |

### 10.1 Modo AUTO
É o modo padrão e dinâmico. O router calcula o tamanho estimado do prompt:
- Prompts com menos de `largeContextThreshold` (100.000 tokens) vão para o `normalProvider` (ex.: APInex).
- Prompts com `largeContextThreshold` ou mais vão diretamente para o `largeContextProvider` (ex.: Gemini).
- Se o provider inicial falhar com erro recuperável (429/5xx), a cadeia de `fallbackOrder` é percorrida em ordem. Provedores em cooldown são ignorados.

### 10.2 Modo CUSTOM (Fallback Manual)
Criado para permitir ao operador ditar a ordem exata das chamadas de IA sem interferência do cálculo de contexto por tokens:
- A chamada sempre se inicia estritamente pelo primeiro item de `fallbackOrder` (`candidateOrder = fallbackOrder.slice()`).
- O volume de tokens (pequeno ou grande) não altera a escolha do primeiro provedor.
- Respeita o cooldown normalmente: se o primeiro da lista falhar e entrar em cooldown, as requisições seguintes usarão o segundo provider da lista até o cooldown expirar.

### 10.3 Modo MANUAL
O operador força a seleção de um provedor específico (via `switcher.bat` ou painel `/admin`):
- O provedor escolhido tem prioridade máxima e **ignora qualquer cooldown existente** (sempre tenta a chamada real ao upstream).
- Se a chamada ao provedor manual falhar, o sistema não desiste: aciona automaticamente a contingência percorrendo o restante do `fallbackOrder`.

---

# 11. Streaming

## 11.1 Comportamento

O router **não bufferiza** mais a resposta. Quando a requisição é `stream: true`, o corpo é repassado em tempo real e o primeiro token chega ao Claude Code assim que o provider começa a responder.

## 11.2 Cancelamento e timeout

O vínculo entre o abort do cliente e o `fetch` upstream, bem como o timer de timeout, **permanecem ativos enquanto o stream estiver em andamento** e só são liberados quando ele termina, falha ou é cancelado. Assim, se o Claude Code desconectar no meio da resposta, o request upstream é abortado em vez de continuar gerando em vão.

## 11.3 Usage de stream

Em stream, o `usage` só aparece no final, depois que `call()` já retornou. O `server.js` lê esse usage e o informa ao router uma única vez por stream via `router.recordUsage()`, mantendo as estatísticas de sessão do router (`/router/status`) corretas. Respostas sem stream continuam sendo contabilizadas pelo próprio router (sem contagem dupla).

## 11.4 Efeito medido

Em teste com upstream simulado emitindo um chunk imediato e outros após 800 ms e 1.600 ms:

| Versão                   | `call()` retornou em | Chunks chegaram ao cliente        |
| ------------------------ | -------------------- | --------------------------------- |
| Antes (bufferizado)      | ~1.500 ms            | todos juntos, no final            |
| Depois (tempo real)      | ~70 ms               | ~70 ms, ~830 ms, ~1.640 ms        |

---

# 12. Observabilidade

Cada requisição ao Claude Code gera um bloco no terminal (exemplo na seção 12.2).

## 12.1 Origem de cada dado

| Dado                                         | Origem            | Observação                                                        |
| -------------------------------------------- | ----------------- | ----------------------------------------------------------------- |
| Tokens estimados, System/Messages/Tools/Other | Router (local)    | Estimativa bytes ÷ 4.                                             |
| Maior tool                                   | Router (local)    | Tool com maior estimativa individual.                             |
| Modo, motivo, provider, modelo, fallback     | Router            | `fallbackCount` e `skipped` indicam falhas/cooldowns.             |
| Input / Output / Total (upstream)            | **Provedor**      | Informado na resposta. Total = Input + Output.                    |
| Diferença input                              | Server            | `Input (upstream) − estimativa local`.                            |
| Duração total                                | Server            | Da chegada da requisição ao fim da resposta.                      |

Pontos de rigor:

* "(upstream)" significa **informado pelo provedor**; não é necessariamente o valor faturado nem a quota restante.
* A estimativa local e o valor do upstream são exibidos **lado a lado** e identificados; nunca misturados como se fossem a mesma medida.
* "Duração total" **não é latência de rede**: inclui o processamento do provider, o streaming e o processamento do proxy.

## 12.2 Exemplo real

```text
════════════════════════════════════════════════════════════
                    CLAUDEZEN REQUEST #1
════════════════════════════════════════════════════════════

📦 CONTEXTO
   Payload             : 86.7 KB
   Tokens estimados    : ~22.194

   System              : ~6.237 tokens
   Messages            : ~347 tokens
   Tools               : ~15.579 tokens
   Other               : ~31 tokens

🧰 TOOLS
   Quantidade          : 25
   Maior               : SendMessage → ~1.435 tokens

🚦 ROTEAMENTO
   Modo                : AUTO
   Motivo              : NORMAL_CONTEXT
   Provider            : APInex
   Modelo              : free/mimo-v2.6-pro

🌐 REQUISIÇÃO
   Endpoint            : POST /v1/messages?beta=true
   Horário             : 00:15:51

📊 USAGE — REQUEST #1
   Input               : 22.457 tokens (upstream)
   Output              : 19 tokens (upstream)
   Total               : 22.476 tokens (upstream)

   Estimativa local    : ~22.194 tokens
   Diferença input     : +263 tokens

🌐 RESPOSTA
   Status              : 200 OK

⏱️ TEMPO
   Duração total       : 3,434 s

════════════════════════════════════════════════════════════
   ✓ USAGE CONFIRMADO PELO UPSTREAM
     Input + Output = 22.476 tokens
════════════════════════════════════════════════════════════

📈 SESSÃO
   Requests            : 1
   Estimado acumulado  : ~22.194 tokens
   Input (upstream)    : 22.457 tokens
   Output (upstream)   : 19 tokens
   Total (upstream)    : 22.476 tokens
   Fallbacks           : 0
   Erros               : 0
```

Neste exemplo, pelos horários do log, o provider levou ~3 s para iniciar a resposta e ~0,4 s para transmiti-la: a espera está no processamento dos ~22 mil tokens de entrada pelo provedor, não no proxy.

## 12.3 Demais saídas

* **Banner de inicialização:** endereço, config, modo, limite de contexto, providers com papel e estado da API key (`●` presente / `○` ausente com o nome da variável), ordem de fallback.
* **Linha curta** para rotas sem bloco próprio (ex.: `ℹ️ HEAD /api/hello → 404 Not Found (5 ms)`, sondagem inofensiva do Claude Code). Requisições com bloco completo ou box de erro não geram linha duplicada.
* **Box de erro** (`CLAUDEZEN REQUEST #n ERROR`): endpoint, status, provider/modelo (se já roteado), duração e mensagem.
* **Encerramento (Ctrl+C):** salva o cache de reasoning, mostra o resumo da sessão e finaliza.
* **Logs técnicos do router** (`[CONTEXT]`, `[ROUTE]`, `[PROVIDER]`, `[STATUS]`, `[ROUTER]`): silenciosos por padrão; ativáveis com `CLAUDEZEN_VERBOSE=1` ou `"routing": { "verbose": true }`.
* **Usage bruto do provider:** `CLAUDE_OPENCODE_LOG_USAGE=1`. O nome é mantido por compatibilidade com a infraestrutura original do projeto.

Observação: com streaming em tempo real e requisições paralelas do Claude Code, blocos de requisições diferentes podem se intercalar no terminal. Por isso o bloco de usage traz o número da requisição (`USAGE — REQUEST #n`).

---

# 13. Segurança das API Keys

As chaves ficam em variáveis de ambiente (`APINEX_API_KEY`, `GEMINI_API_KEY`, `CLAUDEZEN_OPENROUTER_QWEN_API_KEY`, `CLAUDEZEN_OPENROUTER_LAGUNA_API_KEY`); o `config.json` contém apenas `"apiKeyEnv": "APINEX_API_KEY"`. A variável `OPENROUTER_API_KEY` deixou de ser usada (o OpenRouter agora tem duas chaves independentes). Isso reduz o risco de commit acidental, exposição no Git, compartilhamento do arquivo e vazamento em logs. O banner de inicialização avisa quando alguma chave não está definida.

**Novo modelo de armazenamento (Etapa 1).** Além das variáveis de ambiente, as chaves podem ser guardadas localmente em `%USERPROFILE%\.claudezen\secrets.json` (fora do repositório), criado com permissões restritas ao usuário (`0600` quando o Windows permite). A ordem de resolução da chave, por provider, é: (1) chave guardada no `secrets.json` pelo ID do provider; (2) variável de ambiente indicada por `apiKeyEnv`; (3) se nenhuma existir, erro `API key environment variable <NOME> is missing.` O banner indica a origem da chave por provider (`armazenada localmente`, `variável de ambiente <NOME>` ou `ausente`), sem nunca exibir a chave completa — no máximo os 4 últimos caracteres (`...ABCD`). O `secrets.json` **não é criptografado** e fica protegido apenas pelas permissões do perfil do usuário.

**Proteções do painel administrativo (`/admin/api` e interface `/admin`):**
- Token administrativo aleatório por inicialização (`crypto.randomBytes(32)`), exibido no banner; comparação em tempo constante (`crypto.timingSafeEqual`).
- Validação do header `Host` (apenas `127.0.0.1:<porta>` ou `localhost:<porta>`) contra DNS rebinding.
- Validação do header `Origin` em métodos que alteram estado (POST/PUT/PATCH/DELETE) contra CSRF.
- Corpo limitado a 64 KB; sem CORS aberto; erros em português com status HTTP coerentes.
- Nenhuma chave é retornada em resposta HTTP, logada ou commitada (apenas `keySource` e `keyLast4`).
- **Segurança da interface web `/admin`:**
  * Headers HTTP estritos: `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
  * Bloqueio total a scripts e estilos inline, CDNs, bibliotecas remotas e fontes externas.
  * Manipulação segura do DOM: uso estrito de `createElement` e `textContent`, com proibição de `innerHTML`, `outerHTML`, `document.write` ou `eval`.
  * Campo de chave com `type="password"`, `autocomplete="off"` e limpeza imediata da memória/DOM após envio.
  * Token capturado na URL de inicialização, guardado exclusivamente em `sessionStorage` e limpo da barra de endereços com `history.replaceState`.
  * Polling não agressivo (5s) desativado automaticamente quando a aba do navegador fica inativa ou oculta (`visibilitychange`).

---

# 14. Configuração do Claude Code

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "...",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787"
  },
  "model": "qwen/qwen3.8-27b:free"
}
```

O campo `model` é o modelo informado ao Claude Code; o router substitui internamente o modelo enviado ao provider (`free/mimo-v2.6-pro`, `gemini-3.8-flash` ou `qwen/qwen3.8-27b:free`).

---

# 15. Endpoint de status

```text
GET http://127.0.0.1:8787/router/status
```

Retorna `mode`, `manualProvider`, `thresholdTokens`, `fallbackOrder`, `providers` (com `requests`, `successes`, `failures`, `lastStatus`, `lastError`, `lastUsedAt`, `cooldownUntil`, `online`), a sessão agregada e `statePath`.

`online` indica apenas que o provider **não está em cooldown**; não há health check ativo.

---

# 16. Revisão da matemática do router

O `router.js` foi auditado com testes sobre payloads simulados. A fórmula central (`ceil(bytes ÷ 4)`), o cálculo por tool e a escolha da maior tool estavam corretos. Foram encontrados e corrigidos os seguintes problemas:

| # | Problema                                                                                                        | Evidência                                                | Correção                                                          |
| - | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------- |
| 1 | Categoria **System** sempre ~1 token: o system prompt está dentro de `messages` no formato OpenAI e era contado como Messages. | System de 40 mil caracteres contado como 1 token.        | Separação por role `system`/`developer`.                          |
| 2 | **Soma das partes excedia o total** (cada parte arredondada para cima).                                          | Soma 28.795 × total 28.793.                              | `Other` = resto exato; soma fecha.                                |
| 3 | `extractUsage` convertia `null` em `0` e ignorava o campo alternativo (`prompt_tokens`).                         | `input_tokens: null` + `prompt_tokens: 100` → 0.         | `null`/`undefined`/`""` caem no campo alternativo.                |
| 4 | **Latência média** dividia pelo total de requests, mas somava apenas as bem-sucedidas.                           | 1 falha + 1 sucesso de 200 ms → média 101 ms.            | Divisão pelo número de sucessos (→ 201 ms).                       |
| 5 | **Fallback nunca exibido** no log do server (lia o campo `fallback`; o router devolve `fallbackCount`/`skipped`). | Contador de fallbacks sempre 0.                          | Leitura de `fallbackCount` e `skipped`.                           |
| 6 | **Streaming bufferizado** (`response.text()` antes de devolver) e usage vazio em stream.                         | `call()` aguardava o stream inteiro (~1,5 s no teste).   | Repasse em tempo real + `recordUsage()` (seção 11).               |
| 7 | `finish_reason: "stop"` repassado como `stop_reason`, valor inexistente na API Anthropic.                        | Aviso `Unknown upstream finish_reason: stop`.            | `stop`/`content_filter` → `end_turn`; `function_call` → `tool_use`. |

---

# 17. Validação

| Cenário                                                       | Ambiente           | Resultado    |
| ------------------------------------------------------------- | ------------------ | ------------ |
| `node --check router.js` / `server.js`                        | Local              | ✅           |
| `/router/status`                                              | Local              | ✅           |
| AUTO → APInex (contextos ~0,9k a ~22k)                        | **Provider real**  | ✅           |
| MANUAL → Gemini                                               | **Provider real**  | ✅           |
| Retorno para AUTO                                             | **Provider real**  | ✅           |
| Usage upstream × estimativa (+263 tokens, ≈ 1,2%)             | **Provider real**  | ✅           |
| Ausência do aviso `finish_reason: stop`                       | **Provider real**  | ✅           |
| Streaming em tempo real                                       | Upstream simulado  | ✅           |
| Cancelamento do cliente propaga ao upstream; servidor segue de pé | Upstream simulado | ✅           |
| Fallback APInex 503 → Gemini 200                              | Upstream simulado  | ✅           |
| Cadeia APInex 503 → Gemini 503 → OpenRouter 200               | Upstream simulado  | ✅           |
| Cadeia completa 503 → 503 → 503 → 200 (4 providers)           | Upstream simulado  | ✅           |
| Provider em cooldown é pulado no AUTO                         | Upstream simulado  | ✅           |
| MANUAL ignora cooldown e tenta o provider escolhido           | Upstream simulado  | ✅           |
| Mesmo `baseUrl` com modelos diferentes envia o model correto  | Upstream simulado  | ✅           |
| Validação da configuração na inicialização (abort)            | Upstream simulado  | ✅           |
| Derivação do `fallbackOrder` quando ausente                   | Upstream simulado  | ✅           |
| Erro 400 do cliente gera box de erro sem fallback             | Upstream simulado  | ✅           |
| Banner com chave ausente; encerramento com resumo             | Local              | ✅           |
| API administrativa: token ausente/errado (401)               | Upstream simulado  | ✅           |
| API administrativa: Host inválido (403) / Origin divergente (403) | Upstream simulado | ✅           |
| API administrativa: CRUD de providers, fallback, routing, mode | Upstream simulado | ✅           |
| API administrativa: config inválido não grava (422)          | Upstream simulado  | ✅           |
| API administrativa: chave nunca vaza em resposta nem log     | Upstream simulado  | ✅           |
| API administrativa: chave guardada tem prioridade sobre env  | Upstream simulado  | ✅           |
| API administrativa: deletar provider em uso retorna 409      | Upstream simulado  | ✅           |
| API administrativa: recarga a quente mantém cooldown por ID  | Upstream simulado  | ✅           |
| API administrativa: backup criado e limitado a 10            | Upstream simulado  | ✅           |
| API administrativa: teste de conexão com upstream 200 e 503  | Upstream simulado  | ✅           |
| Interface `/admin`: entrega estática (HTML, CSS, JS) com 200 | Upstream simulado  | ✅           |
| Interface `/admin`: headers de segurança (CSP, no-store, nosniff, no-referrer) | Upstream simulado | ✅ |
| Interface `/admin`: proteção de caminhos proibidos e traversal (404) | Upstream simulado | ✅  |
| Interface `/admin`: análise estática (zero innerHTML/eval/CDNs/scripts inline) | Local | ✅        |
| Interface `/admin`: ciclo completo da UI via API (mock upstream, test, order, mode, delete) | Upstream simulado | ✅ |
| Suíte de testes automatizados (`node --test`): 99 testes     | Local              | ✅ (99 pass, 0 fail) |
| **Fallback com falha real de provedor (429/5xx reais)**       | Provider real      | ⏳ **pendente** |

**Nota de rigor:** os cenários de fallback, cooldown, validação, streaming, API administrativa e interface visual `/admin` foram validados com upstreams HTTP locais simulados e análise estática automatizada, comprovando a robustez e segurança do ClaudeZen. Total de 99 testes automatizados cobrindo o projeto. Eles não substituem um teste com falha real de um provedor (por exemplo, esgotar a quota do APInex e observar a transição para o Gemini).

---

# 18. Decisões de design

* **Zero dependência:** nenhuma biblioteca de terceiros para HTTP, roteamento, estimativa, configuração ou switcher. Menos superfície de ataque, menos manutenção, sem `npm install`.
* **Abstração de providers:** permite adicionar outros providers sem alterar o cliente.
* **Failover:** a falha de um provider não derruba o serviço.
* **Override manual:** o operador pode forçar um provider sem editar o `settings.json` do Claude Code nem reiniciar o servidor.
* **Router calcula, server apresenta:** uma única fonte para a estimativa (`routed.context`), evitando divergências entre o que o router decide e o que o log mostra.

---

# 19. Limitações atuais

1. **Falha no meio do stream:** se o provider começou a transmitir e cai, o router não consegue transferir a mesma resposta para outro provider; o fallback é confiável antes do início do stream.
2. **Estimativa aproximada:** não equivale ao tokenizer do modelo (erro de ≈ 1,2% na medição real; pode variar com o conteúdo, por exemplo textos não ASCII ou muito código).
3. **Quotas:** o router não conhece o saldo real de tokens de cada provider.
4. **Health check:** `online` reflete cooldown, não sondagem ativa.
5. **Rota `/v1/chat/completions`:** repassa o corpo sem leitura; não registra usage.
6. **Latência média em stream:** `averageLatencyMs` do router mede o tempo até a resposta começar nas requisições em stream; a duração total aparece no log do server.
7. **Logs intercalados:** requisições paralelas podem intercalar blocos no terminal.

---

# 20. Pontos a melhorar (em desenvolvimento)

Esta seção registra pontos de melhoria identificados ao longo do projeto. Itens já **implementados** são marcados abaixo e passam a fazer parte do código; os **pendentes** continuam listados. O objetivo é manter o estado real do projeto documentado.

## 20.1 Configuração genérica para múltiplos modelos da mesma plataforma — **implementada**

**Motivação.** Plataformas como o OpenRouter expõem vários modelos pelo mesmo endpoint. A configuração original assumia um provider por plataforma (APInex, Gemini, OpenRouter), cada um com um único modelo e uma única variável de chave. Para usar dois modelos do OpenRouter (Qwen e Laguna) como contingências independentes, a configuração passou a tratar **plataforma** e **modelo** como coisas separadas.

**Princípio adotado.** O router identifica cada provider pelo seu **ID** no `config.json`, não pela URL. Dois providers podem compartilhar o mesmo `baseUrl` e continuar sendo entidades distintas, cada uma com `model`, `apiKeyEnv`, `name` e posição própria no `fallbackOrder`:

```text
apinex → gemini → openrouter-qwen → openrouter-laguna
```

**Implementado nessa versão:**

| Ponto | Antes | Agora |
| ----- | ----- | ----- |
| Identidade do provider | `providers[id]` já aceitava IDs arbitrários, mas a configuração fixa limitava. | IDs independentes para cada modelo, incluindo dois do OpenRouter. |
| `fallbackOrder` padrão | Lista fixa (`apinex`, `gemini`, `openrouter`) em `router.js` e `server.js`. | Sem padrão fixo; quando ausente, deriva de `Object.keys(providers)`. |
| `normalProvider` / `largeContextProvider` | Padrões `apinex` e `gemini` fixos no código. | Sem padrão fixo; quando ausentes, derivam do primeiro/segundo provider e avisam no log. |
| ID inexistente no `fallbackOrder` | Ignorado em silêncio. | Validação na inicialização (`validate-config.js`) aborta com mensagem clara. |
| `switcher.bat` | Menu fixo (AUTO, APInex, Gemini, OpenRouter). | Menu dinâmico gerado a partir do `config.json` (`switcher-helper.js`). |
| Chaves de API | Uma variável por provider. | Uma variável por provider: `CLAUDEZEN_OPENROUTER_QWEN_API_KEY` e `CLAUDEZEN_OPENROUTER_LAGUNA_API_KEY`. `OPENROUTER_API_KEY` deixou de ser usada. Atenção: chaves da mesma conta podem compartilhar o limite dos modelos gratuitos. |
| Modelos em `/v1/models` | Lista fixa no config. | Se `models` ausente, deriva dos `model` de todos os providers (sem duplicados). |
| Resquícios do projeto original | Nomes DeepSeek/OpenCode no cache e na lista padrão. | Cache renomeado para `~/.claudezen/reasoning-cache.json`; `DEFAULT_MODELS` removido; `owned_by` neutro. |
| Testes automatizados | Validação manual com upstream simulado. | `test/generic-providers.test.js`, `test/server.test.js`, `test/admin-api.test.js` e `test/admin-ui.test.js`; total de **100 testes** com `node --test` (0 falhas). |

**Configuração final dos providers:**

```json
"providers": {
  "apinex": {
    "name": "APInex",
    "baseUrl": "https://api.apinex.bond/v1",
    "model": "free/mimo-v2.6-pro",
    "apiKeyEnv": "APINEX_API_KEY",
    "timeoutMs": 600000
  },
  "gemini": {
    "name": "Google Gemini",
    "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
    "model": "gemini-3.8-flash",
    "apiKeyEnv": "GEMINI_API_KEY",
    "timeoutMs": 600000
  },
  "openrouter-qwen": {
    "name": "OpenRouter Qwen",
    "baseUrl": "https://openrouter.ai/api/v1",
    "model": "qwen/qwen3.8-27b:free",
    "apiKeyEnv": "CLAUDEZEN_OPENROUTER_QWEN_API_KEY",
    "timeoutMs": 600000
  },
  "openrouter-laguna": {
    "name": "OpenRouter Laguna",
    "baseUrl": "https://openrouter.ai/api/v1",
    "model": "poolside/laguna-s-2.1:free",
    "apiKeyEnv": "CLAUDEZEN_OPENROUTER_LAGUNA_API_KEY",
    "timeoutMs": 600000
  }
}
```

**Evolução possível (proposta, ainda NÃO implementada).** Separar o conceito de plataforma do de provider, para não repetir `baseUrl` e valores comuns:

```json
"platforms": {
  "openrouter": { "baseUrl": "https://openrouter.ai/api/v1", "timeoutMs": 600000 }
},
"providers": {
  "openrouter-qwen":   { "platform": "openrouter", "model": "qwen/qwen3.8-27b:free",       "apiKeyEnv": "..." },
  "openrouter-laguna": { "platform": "openrouter", "model": "poolside/laguna-s-2.1:free", "apiKeyEnv": "..." }
}
```

## 20.2 Pontos pendentes

| Item | Descrição |
| ---- | --------- |
| Teste com falha real de provedor | O fallback foi validado com upstream simulado. Falta validar com 429/5xx reais (veja a seção 17). |
| Separar plataforma de provider | Proposta descrita na seção 20.1 (`platforms` + `providers`), ainda não implementada. |
| Evoluções de resiliência e observabilidade | Circuit breaker, health checks ativos, `Retry-After` e métricas persistentes (veja a seção 21). |

---

## 20.3 API administrativa, armazenamento de chaves, modo CUSTOM e interface visual `/admin` — **Etapas 1, 2 e 3 concluídas**

**Motivação.** Permitir gerenciar providers, chaves, ordem de fallback e modos operacionais (`AUTO`, `CUSTOM` e `MANUAL`) sem editar o `config.json` manualmente nem reiniciar o servidor, oferecendo tanto uma API REST local quanto uma interface web visual completa, modular e segura.

**Implementado na Etapa 1 (Backend & API):**

- **`secrets-store.js`:** armazena chaves em `%USERPROFILE%\.claudezen\secrets.json` (fora do repositório), com escrita atômica e permissões restritas. A chave guardada tem prioridade sobre a variável de ambiente.
- **API administrativa `/admin/api`:** CRUD de providers, gestão de chaves, reordenação do `fallbackOrder`, definição de `normalProvider`/`largeContextProvider`, alternância de modos (`AUTO`, `CUSTOM`, `MANUAL`), teste de conexão e recarga. Toda alteração valida com `validate-config.js` antes de gravar; gravação atômica com backup em `.claudezen-backups/` (máx. 10).
- **Segurança da API:** token aleatório por inicialização (comparação em tempo constante), validação de `Host` (DNS rebinding) e `Origin` (CSRF), corpo limitado a 64 KB, sem CORS aberto.
- **Recarga a quente:** `reloadConfig()` troca a configuração atomicamente; cooldown preservado por ID de provider.
- **Testes da API:** 29 testes em `test/admin-api.test.js` (segurança, CRUD, validação, chaves, fallback, routing, mode, delete, cooldown, backups, conexão upstream 200/503).

**Implementado na Etapa 2 (Interface Visual `/admin`):**

- **Arquivos criados na pasta `admin/`:**
  * `admin/index.html`: layout semântico, acessível e responsivo, sem scripts ou estilos inline, com ícones SVG embutidos.
  * `admin/admin.css`: tema adaptativo claro/escuro (`prefers-color-scheme`), tipografia moderna do sistema, feedback visual de status, botões de ação e modal.
  * `admin/admin.js`: lógica client-side pura (zero npm, zero CDNs), manipulação segura do DOM exclusivamente via `createElement` e `textContent` (zero `innerHTML`), persistência do token em `sessionStorage` e polling de status (5s) pausado quando a aba está oculta (`visibilitychange`).
- **Entrega estática e segurança em `server.js`:**
  * Rotas `/admin`, `/admin/`, `/admin/admin.css` e `/admin/admin.js` servidas com headers estritos: `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
  * Bloqueio rigoroso de path traversal (`/admin/../server.js`, encoding traversal, barras duplas) retornando `404` estrito.
  * Preservação total do proxy `/v1`, switcher e endpoints existentes.
- **Testes da UI (`test/admin-ui.test.js`):**
  * 17 testes automatizados cobrindo entrega estática, headers de segurança, bloqueio de caminhos proibidos, análise estática de conformidade (ausência de `innerHTML`, `eval`, CDNs ou scripts externos), regressão de `/v1` e ciclo funcional completo da interface simulado com mock upstream.

**Implementado na Etapa 3 (Abas Horizontais, Grid Responsivo e Modo CUSTOM):**

- **Reorganização em abas horizontais:** a tela `/admin` foi estruturada em 3 abas sem recarregar página:
  * **Aba 1 (Providers):** grid responsivo em 2+ colunas exibindo cartões de todos os provedores com badges de status, contadores e botão ativo para teste de conexão.
  * **Aba 2 (Roteamento):** separação visual estrita entre **Provider Principal (AUTO)** e **Ordem de Contingência (Fallback)**; seletor dos 3 modos operacionais (`AUTO`, `CUSTOM - Fallback Manual` e `MANUAL`); card explicativo da regra ativa com botão dinâmico para salvar.
  * **Aba 3 (Ordem de Fallback):** controle visual da sequência de contingência com reordenação interativa (botões ↑ e ↓) e modal para cadastro de novos provedores.
  * A aba ativa é lembrada automaticamente entre recargas de tela via `sessionStorage`.
- **Nova regra de negócio: Modo CUSTOM (Fallback Manual):**
  * Suporte em `router.js` (`reason: CUSTOM_ORDER`): as chamadas partem estritamente do primeiro item de `fallbackOrder`, ignorando cálculos de contexto e limites de tokens.
  * `PUT /admin/api/mode` aceita `"custom"`.
  * `switcher-helper.js` valida e grava `"custom"` no `routing-state.json`.
  * Teste unitário automatizado adicionado em `test/generic-providers.test.js`, validando que requisições acima e abaixo do threshold mantêm a ordem da lista sem desviar para o largeContextProvider.
- **Robustez do CRUD e Teste de Providers:**
  * Correção no formulário de criação de providers (`admin.js`): garantia de envio do campo `body.id` na requisição `POST /admin/api/providers`.
  * Persistência de estado de teste (`testStates`): execução de teste do provider é desacoplada do ciclo de polling de 5s, impedindo que requisições lentas de upstream ou timeouts apaguem o feedback na tela ou deixem a interface travada em "testando...".
  * Logs explícitos no console diferenciando o status HTTP da rota administrativa (200 OK) do retorno real do upstream (ex.: 503, 402, 404).
- **Ciclo de vida e reinicialização:**
  * Edições no `config.json` via `/admin/api` são recarregadas a quente na memória.
  * Trocas de modo (`auto`, `custom`, `manual`) são refletidas imediatamente na próxima requisição sem reiniciar o processo.
  * Alterações no código-fonte Node.js (`server.js`, `router.js`, etc.) continuam exigindo reinicialização do processo (`Ctrl+C` e `node server.js`).
- **Total de testes da suíte:** 100 testes automatizados passando sem falhas via `node --test`.

---

# 21. Possíveis evoluções

| Item                      | Descrição                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| Circuit breaker           | `CLOSED → OPEN → HALF-OPEN → CLOSED` no lugar do cooldown fixo.                             |
| Rate-limit awareness      | Respeitar `Retry-After` e `X-RateLimit-Remaining`.                                          |
| Controle de quota         | Tokens usados/restantes por provider, usando o usage real já capturado.                     |
| Pesos por provider        | Distribuição proporcional em vez de ordem fixa.                                             |
| Health checks ativos      | Sondagem periódica dos providers em segundo plano.                                          |
| Métricas persistentes     | Histórico de requests e consumo entre reinicializações.                                     |

---

# 22. Conclusão

O ClaudeZen evoluiu de um bridge de upstream único para uma camada completa e robusta de abstração e roteamento de IA com três modos operacionais (`AUTO`, `CUSTOM` e `MANUAL`), fallback em cadeia, cooldown, **streaming em tempo real**, **observabilidade por requisição** e interface web administrativa `/admin` organizada em abas horizontais com grid responsivo e segurança estrita contra DNS rebinding, CSRF e XSS.

A revisão da arquitetura permitiu desacoplar claramente as responsabilidades:
- O `router.js` decide o provider e gerencia métricas/cooldown;
- O `server.js` faz proxy, conversão de protocolo e serve a interface administrativa;
- O `validate-config.js` protege contra configurações inválidas na inicialização e na API;
- O `secrets-store.js` mantém credenciais sensíveis isoladas do código e versionamento.

```text
Claude Code → ClaudeZen Proxy → Request Router → APInex | Gemini | OpenRouter
                 │ (127.0.0.1:8787)
                 ├── /admin (Painel Web em Abas)
                 └── /admin/api (API Administrativa Local)
```

**Estado final:** 100 testes automatizados (`node --test`) passando com 100% de sucesso. Operacional e validado com provedores reais para AUTO, MANUAL e uso real; fallback, cooldown, modo CUSTOM e streaming validados em ambiente simulado.
