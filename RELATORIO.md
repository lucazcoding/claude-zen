# ClaudeZen Hybrid Router

## Relatório Técnico de Arquitetura, Implementação e Operação

**Projeto:** ClaudeZen
**Ambiente:** Windows
**Runtime:** Node.js
**Arquitetura:** Proxy local + Router multi-provider
**Porta local:** `127.0.0.1:8787`
**Dependências adicionais:** nenhuma
**Última atualização:** 06/10/2026
**Status:** Operacional e **em desenvolvimento ativo**. Fallback em cadeia validado em ambiente simulado; validação com falha real de provedor pendente. Pontos de melhoria já identificados (principalmente configuração genérica para múltiplos modelos da mesma plataforma) estão documentados na [seção 20](#20-pontos-a-melhorar-em-desenvolvimento).

---

# 1. Visão geral

O ClaudeZen foi adaptado de um proxy que encaminhava as requisições para um único upstream para uma arquitetura de roteamento híbrido com três provedores.

A arquitetura atual permite:

* utilização automática do APInex para tarefas normais;
* utilização automática do Gemini para contextos grandes;
* fallback automático entre provedores;
* seleção manual de um provider;
* cooldown temporário de providers que apresentaram falhas;
* **streaming em tempo real**, com cancelamento propagado ao upstream;
* **observabilidade por requisição**: contexto, tools, roteamento, uso real informado pelo provedor e tempo;
* monitoramento via endpoint `/router/status`;
* operação sem dependências externas adicionais;
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
└─────────────────────────────┬───────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────┐
│                    REQUEST ROUTER (router.js)           │
│  Estimativa de contexto · Modo AUTO/MANUAL · Cooldown   │
│  Fallback · Timeout · Métricas de sessão                │
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
| **OpenRouter**    | `https://openrouter.ai/api/v1`                             | `qwen/qwen3.8-27b:free`   | Última contingência        |

> **Nota:** nesta versão cada plataforma é configurada como **um** provider com **um** modelo e **uma** variável de chave. Suportar vários modelos da mesma plataforma (por exemplo, dois modelos do OpenRouter) é um ponto de melhoria em andamento; veja a [seção 20.1](#201-configuração-genérica-para-múltiplos-modelos-da-mesma-plataforma).

---

# 4. Arquitetura de arquivos

```text
C:\AI_config\ClaudeZen\
├── server.js
├── router.js
├── config.json
├── switcher.bat
├── routing-state.json
├── server.backup.js
└── config.backup.json
```

## Princípio de responsabilidades

> **O router calcula. O server apresenta.**

### `router.js`

* analisar o payload e **estimar** o contexto (bytes ÷ 4);
* separar a estimativa em `system`, `messages`, `tools` e `other`;
* escolher o provider (AUTO/MANUAL), aplicar cooldown e fallback;
* aplicar timeout por provider;
* manter métricas de sessão e por provider;
* devolver em `call()` o objeto da requisição (`response`, `provider`, `model`, `contextTokens`, `context`, `routeReason`, `mode`, `fallbackCount`, `skipped`, `observability`);
* expor `recordUsage()` para registrar o usage de streams.

### `server.js`

* servidor HTTP e infraestrutura original do ClaudeZen;
* conversão Anthropic ↔ OpenAI e streaming;
* **apresentar** o bloco de observabilidade, o banner e o resumo de sessão;
* ler o `usage` real do upstream e compará-lo com a estimativa do router.

### `config.json` e `routing-state.json`

`config.json` contém a configuração declarativa (providers e regras). `routing-state.json` representa a escolha operacional do usuário e é lido a cada requisição:

```json
{ "mode": "auto",   "provider": null }
{ "mode": "manual", "provider": "gemini" }
```

### `switcher.bat`

```text
1 - AUTO     2 - APInex     3 - Google Gemini
4 - OpenRouter     5 - STATUS     0 - SAIR
```

Trocar o modo não exige reiniciar o servidor.

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

# 10. AUTO × MANUAL

| Modo   | Quem decide     | Cooldown                                   |
| ------ | --------------- | ------------------------------------------ |
| AUTO   | O router        | Respeitado (provider em cooldown é pulado) |
| MANUAL | O operador      | **Ignorado** para o provider escolhido     |

No MANUAL o provider escolhido é sempre tentado primeiro; se falhar, o restante da ordem de fallback é utilizado. Isso evita o cenário em que o operador seleciona o Gemini e o sistema responde "em cooldown" sem sequer tentá-lo.

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
* **Usage bruto do provider:** `CLAUDE_OPENCODE_LOG_USAGE=1`.

Observação: com streaming em tempo real e requisições paralelas do Claude Code, blocos de requisições diferentes podem se intercalar no terminal. Por isso o bloco de usage traz o número da requisição (`USAGE — REQUEST #n`).

---

# 13. Segurança das API Keys

As chaves ficam em variáveis de ambiente (`APINEX_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`); o `config.json` contém apenas `"apiKeyEnv": "APINEX_API_KEY"`. Isso reduz o risco de commit acidental, exposição no Git, compartilhamento do arquivo e vazamento em logs. O banner de inicialização avisa quando alguma chave não está definida.

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
| Provider em cooldown é pulado no AUTO                         | Upstream simulado  | ✅           |
| MANUAL ignora cooldown e tenta o provider escolhido           | Upstream simulado  | ✅           |
| Erro 400 do cliente gera box de erro sem fallback             | Upstream simulado  | ✅           |
| Banner com chave ausente; encerramento com resumo             | Local              | ✅           |
| **Fallback com falha real de provedor (429/5xx reais)**       | Provider real      | ⏳ **pendente** |

**Nota de rigor:** os cenários de fallback, cooldown e streaming foram validados com upstreams HTTP locais simulados que reproduzem 503 e respostas SSE. Eles comprovam a lógica do ClaudeZen, mas não substituem um teste com falha real de um provedor (por exemplo, esgotar a quota do APInex e observar a transição para o Gemini).

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

Esta seção registra pontos de melhoria identificados após a versão atual do projeto. Eles estão sendo implementados e testados e **ainda não fazem parte do código publicado neste repositório**. O objetivo é manter o estado real do projeto documentado: o que funciona hoje, o que foi percebido como limitação e para onde a arquitetura está indo.

## 20.1 Configuração genérica para múltiplos modelos da mesma plataforma

**Motivação.** Plataformas como o OpenRouter expõem vários modelos pelo mesmo endpoint. A configuração atual foi pensada com um provider por plataforma (APInex, Gemini, OpenRouter), cada um com um único modelo e uma única variável de chave. Ao querer usar, por exemplo, dois modelos do OpenRouter (Qwen e Laguna) como contingências independentes, ficou claro que a configuração precisa tratar **plataforma** e **modelo** como coisas separadas.

**Princípio adotado.** O router identifica cada provider pelo seu **ID** no `config.json`, não pela URL. Dois providers podem compartilhar o mesmo `baseUrl` e continuar sendo entidades distintas, cada uma com `model`, `apiKeyEnv`, `name` e posição própria no `fallbackOrder`:

```text
apinex → gemini → openrouter-qwen → openrouter-laguna
```

**O que a análise do código mostrou:**

| Ponto | Situação na versão atual | Direção |
| ----- | ------------------------ | ------- |
| Identidade do provider | O roteamento usa `providers[id]`; IDs arbitrários já são aceitos. O suporte básico existe e o gargalo está na configuração e nos valores padrão. | Documentar e testar o uso de vários IDs para a mesma plataforma. |
| `fallbackOrder` padrão | A lista padrão (`apinex`, `gemini`, `openrouter`) está escrita diretamente em `router.js` e `server.js`. | Remover o padrão fixo ou derivá-lo de `providers`. |
| `normalProvider` / `largeContextProvider` | Padrões `apinex` e `gemini` fixos no código. | Exigir valor explícito na configuração ou validar no início. |
| ID inexistente no `fallbackOrder` | É ignorado em silêncio. | Validar a configuração na inicialização e avisar com clareza. |
| `switcher.bat` | O menu lista as opções fixas (AUTO, APInex, Gemini, OpenRouter). | Gerar o menu a partir dos providers do `config.json`. |
| Chaves de API | Uma variável por provider (`apiKeyEnv`). | Uma variável por provider, com nomes próprios. Atenção: chaves da mesma conta podem compartilhar o limite dos modelos gratuitos. |
| Documentação | README e relatório descrevem três providers fixos. | Atualizar junto com a implementação. |

**Exemplo da direção em teste** (dois providers que compartilham só o endpoint):

```json
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
```

**Evolução possível (proposta, ainda não implementada).** Separar o conceito de plataforma do de provider, para não repetir `baseUrl` e valores comuns:

```json
"platforms": {
  "openrouter": { "baseUrl": "https://openrouter.ai/api/v1", "timeoutMs": 600000 }
},
"providers": {
  "openrouter-qwen":   { "platform": "openrouter", "model": "qwen/qwen3.8-27b:free",       "apiKeyEnv": "..." },
  "openrouter-laguna": { "platform": "openrouter", "model": "poolside/laguna-s-2.1:free", "apiKeyEnv": "..." }
}
```

## 20.2 Outros pontos identificados

| Item | Descrição |
| ---- | --------- |
| Validação da configuração | Na inicialização: IDs do `fallbackOrder` que não existem em `providers`, `apiKeyEnv` ausente, lista de fallback vazia, `normalProvider` ou `largeContextProvider` fora de `providers`. |
| Limpeza de resquícios do projeto original | O `config.json` e o `server.js` ainda carregam nomes herdados do projeto base (por exemplo, o caminho do cache de reasoning e a lista padrão de modelos com nomes DeepSeek). Revisar o que ainda faz sentido e renomear. |
| Menu dinâmico do `switcher.bat` | Hoje o menu é fixo; precisa acompanhar os providers configurados. |
| Teste com falha real de provedor | Fallback validado em ambiente simulado; falta validar com 429/5xx reais (já listado na seção 17). |
| Testes automatizados | A validação atual é manual e com upstream simulado; transformar os cenários simulados em testes repetíveis. |

---

# 21. Possíveis evoluções

| Item                      | Descrição                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| Circuit breaker           | `CLOSED → OPEN → HALF-OPEN → CLOSED` no lugar do cooldown fixo.                             |
| Rate-limit awareness      | Respeitar `Retry-After` e `X-RateLimit-Remaining`.                                          |
| Controle de quota         | Tokens usados/restantes por provider, usando o usage real já capturado.                     |
| Pesos por provider        | Distribuição proporcional em vez de ordem fixa.                                             |
| Health checks ativos      | Sondagem periódica dos providers.                                                           |
| Dashboard web             | Painel com estado, requests e uso por provider.                                             |
| Métricas persistentes     | Histórico de requests e consumo entre reinicializações.                                     |

---

# 22. Conclusão

O ClaudeZen evoluiu de um bridge de upstream único para uma camada de abstração de providers com dois modos (`AUTO` e `MANUAL`), fallback em cadeia, cooldown, **streaming em tempo real** e **observabilidade por requisição** que separa claramente a estimativa local do uso real informado pelo provedor.

A revisão do `router.js` corrigiu falhas de contabilização (categoria System, soma das partes, `extractUsage`, latência média) e o comportamento de streaming. Em medição real, a estimativa ficou 1,2% abaixo do input informado pelo upstream.

```text
Claude Code → ClaudeZen → Request Router → APInex | Gemini | OpenRouter
```

**Estado final:** operacional e validado com provedores reais para AUTO, MANUAL e uso real; fallback, cooldown e streaming validados em ambiente simulado. O próximo passo recomendado é um teste com falha real de provedor.
