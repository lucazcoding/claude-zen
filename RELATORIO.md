# ClaudeZen Hybrid Router

## Relatório Técnico de Arquitetura, Implementação e Operação

**Projeto:** ClaudeZen
**Ambiente:** Windows
**Runtime:** Node.js
**Arquitetura:** Proxy local + Router multi-provider
**Porta local:** `127.0.0.1:8787`
**Dependências adicionais:** nenhuma
**Status:** Operacional e validado

---

# 1. Visão geral

O ClaudeZen foi adaptado de um proxy que originalmente encaminhava as requisições para um único upstream para uma arquitetura de roteamento híbrido capaz de utilizar três provedores diferentes.

A arquitetura atual permite:

* utilização automática do APInex para tarefas normais;
* utilização automática do Gemini para contextos grandes;
* fallback automático entre provedores;
* seleção manual de um provider;
* cooldown temporário de providers que apresentaram falhas;
* identificação do provider/modelo utilizado em tempo real;
* monitoramento via endpoint `/router/status`;
* operação sem dependências externas adicionais;
* preservação da configuração existente do Claude Code.

A arquitetura pode ser resumida como:

```text
┌─────────────────────────────────────────────────────────┐
│                       CLAUDE CODE                       │
│                                                         │
│ model configurado: qwen/qwen3.8-27b:free               │
│ base URL: http://127.0.0.1:8787                        │
└─────────────────────────────┬───────────────────────────┘
                              │
                              │ HTTP
                              ▼
┌─────────────────────────────────────────────────────────┐
│                    CLAUDEZEN PROXY                      │
│                    127.0.0.1:8787                      │
│                                                         │
│  Anthropic/OpenAI compatibility                         │
│  Streaming                                               │
│  Request conversion                                      │
│  Reasoning cache                                         │
└─────────────────────────────┬───────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────┐
│                    REQUEST ROUTER                       │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │ Request Analyzer                                  │  │
│  │                                                   │  │
│  │ • tamanho estimado do contexto                   │  │
│  │ • modo AUTO/MANUAL                               │  │
│  │ • health/cooldown                                │  │
│  │ • prioridade dos providers                       │  │
│  └───────────────────────────┬───────────────────────┘  │
│                              │                          │
└──────────────────────────────┼──────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
       ┌────────────┐   ┌────────────┐   ┌────────────┐
       │   APInex   │   │   Gemini   │   │ OpenRouter │
       │            │   │            │   │            │
       │ Trabalhador│   │ Contexto   │   │  Reserva   │
       │ diário     │   │ grande     │   │  final     │
       └────────────┘   └────────────┘   └────────────┘
```

---

# 2. Objetivo da arquitetura

O objetivo principal não é simplesmente distribuir requisições.

A finalidade é criar uma camada de abstração entre o Claude Code e os provedores externos.

O Claude Code não precisa saber qual API está sendo utilizada.

Ele sempre conversa com:

```text
http://127.0.0.1:8787
```

O ClaudeZen decide internamente:

```text
Qual provider?
Qual modelo?
Está disponível?
Está em cooldown?
É uma requisição grande?
O provider anterior falhou?
```

Isso transforma o ClaudeZen em uma camada de infraestrutura independente do provider.

---

# 3. Providers configurados

## 3.1 APInex

```text
Nome: APInex
Base URL:
https://api.apinex.bond/v1

Modelo:
free/mimo-v2.6-pro

Função:
Provider principal
```

É o provider utilizado normalmente no modo automático.

Regra:

```text
contexto < 100.000 tokens
        ↓
APInex
```

---

# 3.2 Google Gemini

```text
Nome: Google Gemini

Base URL:
https://generativelanguage.googleapis.com/v1beta/openai

Modelo:
gemini-3.8-flash

Função:
Provider especializado em contextos grandes
```

Regra:

```text
contexto >= 100.000 tokens
        ↓
Gemini
```

Também funciona como primeiro fallback do APInex.

---

# 3.3 OpenRouter

```text
Nome: OpenRouter

Base URL:
https://openrouter.ai/api/v1

Modelo:
qwen/qwen3.8-27b:free

Função:
Última camada de contingência
```

O OpenRouter funciona como terceira camada:

```text
APInex
   ↓ falha
Gemini
   ↓ falha
OpenRouter
```

---

# 4. Arquitetura de arquivos

A estrutura relevante ficou:

```text
C:\AI_config\ClaudeZen\
│
├── server.js
├── router.js
├── config.json
├── switcher.bat
├── routing-state.json
│
├── server.backup.js
└── config.backup.json
```

## Responsabilidade de cada arquivo

### `server.js`

Responsável pelo servidor HTTP e pela infraestrutura original do ClaudeZen.

Principais responsabilidades:

* receber requisições;
* lidar com endpoints;
* conversão Anthropic/OpenAI;
* streaming;
* tratamento de respostas;
* health endpoint;
* integração com o Router.

O `server.js` não precisa conhecer a lógica específica dos três providers.

---

### `router.js`

É o componente responsável pela decisão de roteamento.

Responsabilidades:

```text
Provider selection
Context estimation
Fallback
Cooldown
Timeout
Health state
Manual mode
Automatic mode
Provider logging
```

Essa separação é importante porque mantém a infraestrutura HTTP separada da lógica de seleção.

---

### `config.json`

Contém a configuração declarativa.

Exemplo conceitual:

```json
{
  "routing": {
    "mode": "auto",
    "largeContextThreshold": 100000,
    "normalProvider": "apinex",
    "largeContextProvider": "gemini",
    "fallbackOrder": [
      "apinex",
      "gemini",
      "openrouter"
    ],
    "cooldownSeconds": 300
  }
}
```

---

### `routing-state.json`

Representa o estado operacional escolhido pelo usuário.

AUTO:

```json
{
  "mode": "auto",
  "provider": null
}
```

Gemini manual:

```json
{
  "mode": "manual",
  "provider": "gemini"
}
```

APInex manual:

```json
{
  "mode": "manual",
  "provider": "apinex"
}
```

OpenRouter manual:

```json
{
  "mode": "manual",
  "provider": "openrouter"
}
```

---

### `switcher.bat`

Interface operacional para troca rápida de provider.

Menu:

```text
1 - AUTO
2 - APInex
3 - Google Gemini
4 - OpenRouter
5 - STATUS
0 - SAIR
```

Não é necessário reiniciar o ClaudeZen para alterar o modo.

---

# 5. Fluxo de uma requisição

O fluxo completo é:

```text
Claude Code
     │
     ▼
POST /v1/messages
     │
     ▼
ClaudeZen server.js
     │
     ▼
Anthropic → OpenAI conversion
     │
     ▼
router.js
     │
     ├── identifica modo
     │
     ├── estima tamanho
     │
     ├── verifica cooldown
     │
     └── determina provider
     │
     ▼
Provider externo
     │
     ▼
Resposta
     │
     ▼
OpenAI → Anthropic conversion
     │
     ▼
Claude Code
```

---

# 6. Roteamento automático

O modo padrão é:

```text
AUTO
```

O Router estima o tamanho do payload.

O limite configurado é:

```text
100.000 tokens
```

A regra é:

```text
              AUTO
                │
       ┌────────┴────────┐
       │                 │
    < 100k             >= 100k
       │                 │
       ▼                 ▼
    APInex             Gemini
```

---

# 7. Por que a estimativa não é um tokenizer real?

O Router utiliza uma estimativa baseada no tamanho do JSON.

Conceitualmente:

```text
tokens ≈ bytes / 4
```

Essa métrica não pretende reproduzir exatamente o tokenizer de cada modelo.

Ela existe para tomar uma decisão operacional:

```text
requisição pequena
        vs
requisição grande
```

Isso evita adicionar dependências de tokenizer específicas de cada provider.

Como consequência, o limite de `100.000` deve ser entendido como um **threshold aproximado**, e não como uma contagem criptograficamente exata de tokens.

---

# 8. Fallback automático

O fallback ocorre quando um provider apresenta erro considerado recuperável.

Status tratados como recuperáveis:

```text
408
425
429
500
501
502
503
504
...
599
```

Também são considerados problemas recuperáveis alguns erros de rede:

```text
ETIMEDOUT
ECONNRESET
ECONNREFUSED
ECONNABORTED
ENOTFOUND
EAI_AGAIN
```

Fluxo:

```text
              APInex
                 │
           ┌─────┴─────┐
           │           │
         200          erro
           │           │
           ▼           ▼
          FIM        Gemini
                       │
                 ┌─────┴─────┐
                 │           │
                200         erro
                 │           │
                 ▼           ▼
                FIM       OpenRouter
```

---

# 9. Cooldown

Quando um provider apresenta uma falha recuperável, ele entra temporariamente em cooldown.

Configuração atual:

```text
300 segundos
```

Ou:

```text
5 minutos
```

Exemplo:

```text
APInex
  ↓
429
  ↓
cooldown 5 min
  ↓
Gemini
```

Enquanto o APInex estiver em cooldown, o modo AUTO evita utilizá-lo.

---

# 10. Diferença entre AUTO e MANUAL

Essa distinção é importante.

## AUTO

O Router possui liberdade para escolher.

Exemplo:

```text
AUTO
 ↓
APInex
 ↓
429
 ↓
Gemini
```

Cooldowns são respeitados.

---

## MANUAL

O usuário determina explicitamente o provider.

Exemplo:

```text
MANUAL
provider = gemini
```

O Router tenta Gemini mesmo que ele esteja marcado em cooldown.

Isso foi corrigido durante os testes.

A lógica final é:

```text
AUTO
 └── respeita cooldown

MANUAL
 └── respeita escolha explícita do usuário
```

Isso evita uma situação em que o usuário seleciona Gemini e o sistema simplesmente responde:

```text
Gemini está em cooldown
503
```

sem sequer tentar o provider escolhido.

---

# 11. Switcher

O `switcher.bat` funciona como uma pequena camada de controle operacional.

## AUTO

```text
1
```

gera:

```json
{
  "mode": "auto",
  "provider": null
}
```

## APInex

```text
2
```

gera:

```json
{
  "mode": "manual",
  "provider": "apinex"
}
```

## Gemini

```text
3
```

gera:

```json
{
  "mode": "manual",
  "provider": "gemini"
}
```

## OpenRouter

```text
4
```

gera:

```json
{
  "mode": "manual",
  "provider": "openrouter"
}
```

Não é necessário reiniciar o servidor para trocar o provider.

---

# 12. Segurança das API Keys

As chaves não ficam armazenadas no `config.json`.

São utilizadas através de variáveis de ambiente:

```text
APINEX_API_KEY
GEMINI_API_KEY
OPENROUTER_API_KEY
```

Exemplo:

```powershell
setx APINEX_API_KEY "..."
setx GEMINI_API_KEY "..."
setx OPENROUTER_API_KEY "..."
```

O `config.json` contém apenas:

```json
"apiKeyEnv": "APINEX_API_KEY"
```

Isso reduz o risco de:

* commit acidental de API keys;
* exposição no Git;
* compartilhamento do arquivo de configuração;
* vazamento através de logs.

---

# 13. Configuração do Claude Code

O Claude Code continua utilizando:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "...",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787"
  },
  "model": "qwen/qwen3.8-27b:free"
}
```

O campo:

```text
model
```

continua mostrando:

```text
qwen/qwen3.8-27b:free
```

Isso não significa que esse é necessariamente o modelo utilizado pelo upstream.

Ele representa o modelo informado ao Claude Code.

O Router substitui internamente o modelo enviado ao provider.

Exemplo:

```text
Claude Code

model:
qwen/qwen3.8-27b:free

        ↓

ClaudeZen Router

        ↓

APInex:
free/mimo-v2.6-pro
```

ou:

```text
Claude Code

qwen/qwen3.8-27b:free

        ↓

ClaudeZen Router

        ↓

Gemini:
gemini-3.8-flash
```

Essa abstração permite trocar o backend sem precisar reconfigurar o Claude Code.

---

# 14. Endpoint de status

Foi criado:

```text
GET /router/status
```

Exemplo:

```text
http://127.0.0.1:8787/router/status
```

O endpoint fornece:

```text
mode
manualProvider
thresholdTokens
fallbackOrder
providers
statePath
```

Além disso, cada provider possui métricas:

```text
requests
successes
failures
lastStatus
lastError
lastUsedAt
cooldownUntil
online
```

---

# 15. Estado validado

Durante os testes, o Router apresentou:

```json
{
  "mode": "auto",
  "manualProvider": null,
  "thresholdTokens": 100000,
  "fallbackOrder": [
    "apinex",
    "gemini",
    "openrouter"
  ]
}
```

APInex:

```text
requests: 2
successes: 2
failures: 0
lastStatus: 200
```

Gemini:

```text
requests: 1
successes: 1
failures: 0
lastStatus: 200
```

OpenRouter:

```text
requests: 0
successes: 0
failures: 0
```

Isso demonstra que APInex e Gemini foram efetivamente utilizados e responderam com sucesso.

---

# 16. Testes realizados

## Teste 1 — Sintaxe

Executado:

```powershell
node --check router.js
node --check server.js
```

Resultado:

```text
PASS
PASS
```

---

## Teste 2 — Router status

Executado:

```text
GET /router/status
```

Resultado:

```text
200 OK
```

---

## Teste 3 — AUTO + APInex

Contextos observados:

```text
~921 tokens
~19.629 tokens
~19.665 tokens
```

Resultado:

```text
APInex
free/mimo-v2.6-pro
200 OK
```

---

## Teste 4 — Gemini manual

Configuração:

```text
MANUAL
Gemini
```

Resultado:

```text
Google Gemini
gemini-3.8-flash
200 OK
```

---

## Teste 5 — retorno para AUTO

Configuração:

```text
AUTO
```

Resultado:

```text
APInex
free/mimo-v2.6-pro
200 OK
```

---

# 17. Teste que não foi realizado

O fallback real provocado artificialmente ainda não foi executado.

Ou seja, ainda não foi forçada uma sequência real:

```text
APInex → 429
       ↓
Gemini → 200
```

nem:

```text
APInex → falha
Gemini → falha
OpenRouter → 200
```

A lógica está implementada, mas esse comportamento específico não deve ser declarado como empiricamente validado.

---

# 18. Logs

O Router gera logs semelhantes a:

```text
[03:19:14] [ROUTE] mode=auto context=~19,665 tokens reason=NORMAL_CONTEXT

[03:19:14] [PROVIDER]
APInex -> free/mimo-v2.6-pro

[03:19:16] [STATUS]
APInex -> 200 OK

[03:19:16] [ROUTER]
AUTO -> APInex -> free/mimo-v2.6-pro
-> ~19665 tokens
-> NORMAL_CONTEXT
```

Para Gemini:

```text
[03:17:20] [ROUTE]
mode=manual
context=~19,611 tokens
reason=MANUAL

[03:17:20] [PROVIDER]
Google Gemini -> gemini-3.8-flash

[03:17:39] [STATUS]
Google Gemini -> 200 OK
```

---

# 19. Design arquitetural

A arquitetura pode ser dividida em quatro camadas.

```text
┌───────────────────────────────────────────────┐
│                 CLIENT LAYER                  │
│                                               │
│                  Claude Code                  │
└───────────────────────┬───────────────────────┘
                        │
                        ▼
┌───────────────────────────────────────────────┐
│               PROXY LAYER                    │
│                                               │
│                  server.js                   │
│                                               │
│ • HTTP server                                │
│ • Anthropic/OpenAI conversion                │
│ • Streaming                                  │
│ • Response handling                          │
└───────────────────────┬───────────────────────┘
                        │
                        ▼
┌───────────────────────────────────────────────┐
│               ROUTING LAYER                   │
│                                               │
│                  router.js                   │
│                                               │
│ • Context estimation                         │
│ • Provider selection                         │
│ • Fallback                                   │
│ • Cooldown                                   │
│ • Manual routing                             │
│ • Automatic routing                          │
└───────────────┬───────────────┬───────────────┘
                │               │
                ▼               ▼
       ┌────────────────┐ ┌────────────────┐
       │ Provider APIs  │ │ Provider APIs  │
       │                │ │                │
       │ APInex         │ │ Gemini         │
       └────────────────┘ └────────────────┘
                │
                ▼
       ┌────────────────┐
       │   OpenRouter   │
       │   Last Resort  │
       └────────────────┘
```

---

# 20. Design decisions

## Zero dependency

Não foi adicionada uma biblioteca de terceiros para:

* HTTP;
* router;
* token estimation;
* configuração;
* switcher.

Isso reduz:

* superfície de ataque;
* manutenção;
* problemas de compatibilidade;
* necessidade de `npm install`.

---

## Provider abstraction

O Claude Code não precisa conhecer os providers.

Isso permite adicionar posteriormente:

```text
Provider 4
Provider 5
Provider 6
```

sem alterar o cliente.

---

## Failover

A falha de um provider não precisa derrubar o serviço inteiro.

A intenção é:

```text
Provider failure
      ↓
Router
      ↓
Next provider
```

---

## Manual override

O operador mantém controle direto.

Isso é importante para situações como:

```text
"Quero usar Gemini agora."
```

sem precisar editar:

```text
settings.json
```

ou reiniciar o servidor.

---

# 21. Limitações atuais

### 21.1 Context estimation

A contagem é aproximada.

Não representa exatamente o tokenizer de cada modelo.

---

### 21.2 Streaming failure

Se um provider já começou a transmitir uma resposta e falhar no meio do stream, o Router não consegue transferir de forma transparente a mesma conversa para outro provider.

Exemplo:

```text
APInex
 ↓
200
 ↓
stream iniciado
 ↓
falha
```

Não é seguro simplesmente iniciar:

```text
Gemini
```

no meio da resposta.

O fallback é mais confiável antes do início do streaming.

---

### 21.3 Provider quotas

O Router não possui ainda um contador real de:

```text
tokens consumidos/dia
```

Ele possui métricas de requests e erros.

A quota real continua sendo determinada pelo provider.

---

### 21.4 Health check ativo

O status `online` atualmente representa principalmente o estado de cooldown conhecido pelo Router.

Não significa que o provider esteja sendo continuamente testado por health probes externos.

---

# 22. Possíveis evoluções

A arquitetura permite evoluções futuras.

## Priority weights

Em vez de:

```text
APInex → Gemini → OpenRouter
```

poderia existir:

```text
APInex 70%
Gemini 20%
OpenRouter 10%
```

---

## Token budget tracking

Adicionar:

```text
tokens usados hoje
tokens restantes
estimativa de consumo
```

---

## Rate-limit awareness

Detectar headers como:

```text
Retry-After
X-RateLimit-Remaining
```

quando fornecidos pelos providers.

---

## Circuit breaker

Evoluir o cooldown para um circuito formal:

```text
CLOSED
   ↓
falhas
   ↓
OPEN
   ↓
aguarda
   ↓
HALF-OPEN
   ↓
teste
   ↓
CLOSED
```

---

## Dashboard

Criar uma interface web:

```text
ClaudeZen Dashboard

APInex       🟢
Gemini       🟢
OpenRouter   🟢

Mode: AUTO

Requests:
APInex       2
Gemini       1
OpenRouter   0
```

---

# 23. Conclusão

O ClaudeZen deixou de ser simplesmente um bridge com um único upstream e passou a possuir uma camada de abstração de providers.

A arquitetura atual é:

```text
Claude Code
     ↓
ClaudeZen
     ↓
Request Router
     ↓
┌────────────┬────────────┬────────────┐
│   APInex   │   Gemini   │ OpenRouter │
└────────────┴────────────┴────────────┘
```

Com dois modos operacionais:

```text
AUTO
```

e:

```text
MANUAL
```

O modo AUTO prioriza:

```text
APInex → Gemini → OpenRouter
```

e utiliza o tamanho estimado do contexto para decidir entre APInex e Gemini.

O modo MANUAL permite ao operador escolher diretamente o provider.

O sistema foi validado com sucesso para:

* inicialização;
* sintaxe;
* status;
* APInex;
* Gemini;
* troca manual;
* retorno para AUTO;
* processamento real pelo Claude Code;
* logs de provider/modelo;
* respostas HTTP 200.

O fallback automático está implementado, mas o teste artificial de falha em cadeia ainda não foi executado.

**Estado final:** arquitetura funcional, operacional e preparada para evolução.
