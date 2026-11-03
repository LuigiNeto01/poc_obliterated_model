# POC — Codex CLI + Qwen3.8-27B OBLITERATED (agente autônomo de desenvolvimento)

Prova de conceito de um agente de desenvolvimento que usa o **Codex CLI open source** (sem fork) e
tem como **único cérebro** o modelo **Qwen3.8-27B OBLITERATED**, servido pela **Opper AI**.

O modelo **não tem tool calling nativo**. Ele opera as ferramentas por um **protocolo JSON**
interpretado pelo **qwen-bridge**, uma camada determinística que faz parser, validação por schema,
política de permissões e tradução para as ferramentas nativas do Codex.

> **Status (2026-11-03):** a implementação está completa e validada **sem API real**: 45 testes
> unitários, E2E com o Codex real + modelo simulado, nos modos local e Docker, incluindo o teste de
> navegador. O **teste com o Qwen real ainda não foi executado** porque nenhuma chave da Opper estava
> disponível. Detalhes em [`REPORT.md`](REPORT.md).

```
Usuário → Codex CLI 0.166.0 ──/v1/responses──► qwen-bridge ──chat/completions──► Opper: heabsy/qwen38-obl
              ▲  executa (terminal, apply_patch,        │ parser JSON → schema → política
              │  processos, Playwright MCP)             │ → tradução para ferramenta nativa
              └────────── function_call ◄───────────────┘
```

Arquitetura completa e justificativas: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Modelo e provedor (verificado em 2026-11-03)

| Item | Valor | Como foi verificado |
|---|---|---|
| ID na Opper | `heabsy/qwen38-obl` ("Qwen3.8 27B Obliterated") | catálogo público `GET https://api.opper.ai/v3/models`; a referência do item aponta para `huggingface.co/OBLITERATUS/Qwen3.8-27B-OBLITERATED` |
| Endpoint | `https://api.opper.ai/v3/compat/chat/completions` (compatível com OpenAI) | docs.opper.ai + chamada real (401 com chave inválida) |
| Autenticação | `Authorization: Bearer <OPPER_API_KEY>` (chaves começam com `op-`) | docs + resposta 401 real |
| Capacidades | **apenas `text`** (sem `tools`, sem visão) | catálogo |
| Contexto / saída | 524.288 / 32.768 tokens | catálogo |
| Preço | US$ 0,17 entrada / US$ 1,19 saída por milhão de tokens | catálogo |
| Grupo de acesso | `abliterated` | catálogo: **pode exigir habilitação na conta** (pendência) |
| Parâmetros recomendados (card HF) | temperatura 0,1–0,3, `max_tokens` 1024–2048, `repetition_penalty` 1,15 | o catálogo **não** lista `repetition_penalty` para este modelo, então ele fica opcional via `OPPER_EXTRA_PARAMS` |

## Requisitos

- **Windows 11 (recomendado):** Docker Desktop com backend WSL2 e Git for Windows. Node no Windows **não** é necessário.
- **Linux / WSL2 / macOS:** Docker, ou Node ≥ 22.18 para o modo local sem container.

## Início rápido no Windows 11 (PowerShell)

```powershell
git clone https://github.com/LuigiNeto01/poc_obliterated_model.git
cd poc_obliterated_model
.\scripts\setup.ps1                         # build da imagem + testes unitários dentro do container
notepad .env                                # preencha OPPER_API_KEY (o setup cria o .env a partir do .env.example)
.\scripts\check-api.ps1                     # 1 chamada pequena: valida chave, modelo e formato
.\scripts\prepare-workspace.ps1 discount-bug
.\scripts\agent.ps1 -Workspace .\workspace\discount-bug     # abre o Codex (TUI) conversando com o Qwen
```

Equivalente em Linux/WSL2/macOS:

```bash
cp .env.example .env && $EDITOR .env        # preencha OPPER_API_KEY
docker compose -f docker/compose.yml build
docker run --rm --env-file .env qwen-agent:local node scripts/check-api.mjs
scripts/prepare-workspace.sh discount-bug
scripts/docker-agent.sh workspace/discount-bug
```

## Configuração da API

1. Copie `.env.example` para `.env` (o `.env` está no `.gitignore` e nunca deve ser commitado).
2. Preencha `OPPER_API_KEY`. `OPPER_BASE_URL` e `OPPER_MODEL` já vêm com os valores confirmados acima.
3. Rode o `check-api`. A saída mostra endpoint, modelo, se a chave está configurada (**nunca o valor**),
   dados do catálogo, latência, `usage` e se a resposta seguiu o protocolo JSON.

Para trocar de provedor, aponte `OPPER_BASE_URL` para qualquer endpoint compatível com
Chat Completions e ajuste `OPPER_MODEL`.

## Primeiro teste obrigatório (projeto com bug)

`examples/discount-bug` é um projeto Node/TypeScript sem dependências. Ele tem 6 testes, e 1 falha
de propósito. O `prepare-workspace` copia o projeto para `workspace/discount-bug` **sem o README**,
que contém a resposta, e faz um commit inicial para facilitar a inspeção do `git diff`.

Na sessão do Codex, envie:

> Investigue por que os testes deste projeto estão falhando. Leia o código, execute os testes, identifique a
> causa, implemente uma correção mínima e execute os testes novamente. Ao terminar, explique o problema e
> as alterações realizadas.

Ou rode sem interação:

```powershell
.\scripts\agent.ps1 -Workspace .\workspace\discount-bug -Exec "Investigue por que os testes deste projeto estão falhando. Leia o código, execute os testes, identifique a causa, implemente uma correção mínima e execute os testes novamente. Ao terminar, explique o problema e as alterações realizadas."
```

Ou faça tudo de uma vez (preparar, executar, verificar fora do agente e resumir os logs). Os
artefatos ficam em `.run/real-<cenário>-<data>/`:

```powershell
.\scripts\real-test.ps1                 # Windows   (cenário discount-bug)
scripts/real-test.sh                    # Linux/WSL (cenário discount-bug; use web-form-bug para o teste 2)
```

**Como verificar de verdade (não confie no resumo do modelo):**

```bash
cd workspace/discount-bug && git diff && npm test     # ou: docker run --rm -v "$PWD:/ws" -w /ws qwen-agent:local npm test
npm run logs -- logs --timeline                       # linha do tempo: ferramentas, erros por categoria, tokens, custo
```

O relatório do teste real deve registrar cada um dos 9 critérios de sucesso e, se algo falhar, a etapa exata
(modelo / parser / validação / política / API / ferramenta). Veja o modelo de relatório em `REPORT.md`.

## Autorização explícita de ações

O bridge classifica cada ação de forma determinística:

- **Negado sempre**, sem autorização possível: sudo, `rm -rf /`, leitura de `.env`/chaves, despejo de
  variáveis de ambiente, `curl | sh`, docker, ssh, `git push --force`, caminhos fora do workspace etc.
- **Exige autorização:** apagar arquivos, instalar dependências, `npx`, `git push`/`reset --hard`, URLs externas, `kill`.
  O turno é suspenso e o agente mostra:
  `⚠️ Autorização necessária … Para autorizar UMA vez, responda: autorizo 3F9A`.
  Só uma mensagem **sua** com esse código libera aquela ação específica.
- **Permitido:** leitura, busca, edição dentro do workspace, testes, builds, servidores locais.

## Segundo teste: navegador (opcional)

```powershell
.\scripts\prepare-workspace.ps1 web-form-bug
.\scripts\agent.ps1 -Workspace .\workspace\web-form-bug -Browser
```

Tarefa sugerida (também em `mock/scenarios/web-form-bug.json`):

> A página de orçamento não mostra o total depois de clicar em Calcular. Inicie a aplicação
> (node server.mjs, porta 3000), abra a página no navegador, preencha Quantidade=2 e Preço unitário=19.90,
> clique em Calcular, identifique o problema, corrija o código e repita a interação para validar. Ao final,
> encerre o servidor e explique a causa e a correção.

O navegador é o Chromium headless do `@playwright/mcp`, dentro do container do agente. O modelo
textual "enxerga" a página pela árvore de acessibilidade (`browser.snapshot`), pelo console e pela
rede. Screenshots são só evidência. Verificação independente:
`docker run --rm -e PLAYWRIGHT_NO_SANDBOX=1 -v "<workspace>:/ws" qwen-agent:local node scripts/verify-web-form-bug.mjs /ws`.

## Testes sem API real

```bash
npm ci && npm test                       # 45 testes unitários do bridge
scripts/e2e-mock.sh                      # Codex real + bridge + Qwen simulado, modo local (sandbox do Codex)
scripts/e2e-docker-mock.sh               # o mesmo na topologia de containers
scripts/e2e-docker-mock.sh web-form-bug  # segundo teste (navegador) com Qwen simulado
```

O "Qwen simulado" (`mock/mock-qwen.mjs`) segue um roteiro e **confere** se cada resultado esperado
chegou ao modelo. Inclui de propósito uma resposta com `<think>` + markdown, um JSON inválido e uma
tentativa de ler `.env`. O mock **não mede a competência do Qwen**: ele valida o encanamento entre
protocolo, ferramentas e retorno de resultados.

## Logs e diagnóstico

- `logs/bridge-AAAA-MM-DD.jsonl` e `logs/sessions/<sessão>.jsonl`: prompt completo enviado, resposta
  bruta, tokens, custo estimado, ferramenta e argumentos validados, tradução para o Codex, resultado,
  erros por categoria e autorizações. As chaves aparecem como `[REDACTED]`.
- `npm run logs -- logs --timeline`: resumo por sessão.
- Categorias de erro: `parser` (JSON inválido), `validation` (ferramenta/argumentos), `policy` (negado),
  `loop` (ação repetida), `limit` (passos), `repair_exhausted`, `api` (HTTP/rede), `tool` (exit code ≠ 0), `bridge`.

## Variáveis principais (`.env`)

| Variável | Padrão | Descrição |
|---|---|---|
| `OPPER_API_KEY` | — | chave da Opper (obrigatória para o teste real) |
| `OPPER_BASE_URL` | `https://api.opper.ai/v3/compat` | endpoint compatível com Chat Completions |
| `OPPER_MODEL` | `heabsy/qwen38-obl` | ID do modelo |
| `OPPER_TEMPERATURE` / `OPPER_MAX_TOKENS` | `0.2` / `2048` | parâmetros de geração |
| `OPPER_EXTRA_PARAMS` | `{}` | JSON extra, ex.: `{"repetition_penalty":1.15}` |
| `BRIDGE_MAX_STEPS` | `40` | máximo de ferramentas por turno |
| `BRIDGE_MAX_REPAIRS` | `3` | tentativas de correção de formato por resposta |
| `BRIDGE_PROTOCOL_ROLE` | `system` | `user` coloca o protocolo na 1ª mensagem do usuário (o card do modelo desaconselha system prompt) |
| `BRIDGE_LOG_PROMPTS` | `full` | `none` deixa de gravar os prompts completos |

## Modo local sem Docker (Linux/WSL2: desenvolvimento do bridge)

```bash
scripts/setup.sh
AGENT_WORKSPACE=workspace/discount-bug scripts/agent.sh            # TUI
AGENT_WORKSPACE=workspace/discount-bug scripts/agent.sh exec "..."  # autônomo
```

Usa o sandbox `workspace-write` do Codex, com a rede desligada. Limitações medidas: o seccomp do Codex
quebra o detalhamento do `node --test` e impede servidores locais de escutar. No WSL2 os comandos
conseguem **ler** `/mnt/c`. Por isso o modo recomendado é o Docker.

## Estrutura

```
bridge/src/        qwen-bridge (server, agent, protocol, tools, policy, convert, opper, logger)
bridge/test/       testes unitários (node:test)
docker/            Dockerfile, compose.yml (agent ⟷ bridge), compose.mock.yml
examples/          discount-bug (teste 1), web-form-bug (teste 2)
mock/              Qwen simulado + roteiros
scripts/           setup, agent (sh/ps1), docker-agent, prepare-workspace, check-api, e2e, logs
docs/              ARCHITECTURE.md
REPORT.md          relatório dos testes realizados
```

## Atualizar o Codex

O Codex não é modificado. Para atualizar: `npm install @openai/codex@<versão> --save-exact`, depois
`npm test`, `scripts/e2e-docker-mock.sh` e `scripts/e2e-docker-mock.sh web-form-bug`. Os pontos de
contato com o Codex são: `wire_api = "responses"`, `exec_command`/`write_stdin` com interceptação de
`apply_patch`, devolução de `reasoning.encrypted_content` e ferramentas MCP em `namespace`.
