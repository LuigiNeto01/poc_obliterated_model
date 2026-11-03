# Arquitetura — Codex CLI + Qwen Obliterated

## 1. O que foi inspecionado no Codex

Repositório oficial `openai/codex`, inspecionado em 2026-11-03 (commit `0ddee3e`). O executável usado é
a release **`@openai/codex@0.166.0`** (tag `rust-v0.166.0`), fixada no `package-lock.json`.

| Tema | Onde fica no Codex | O que importa para a POC |
|---|---|---|
| Provedores | `codex-rs/model-provider-info/src/lib.rs` | Provedores customizados via `[model_providers.<id>]` (`base_url`, `env_key`, `wire_api`). **Só `wire_api = "responses"` é aceito**: `"chat"` foi removido (`CHAT_WIRE_API_REMOVED_ERROR`). |
| Protocolo / SSE | `codex-rs/codex-api/src/sse/responses.rs` | Eventos consumidos: `response.created`, `response.output_item.done`, `response.completed` (com `usage`), entre outros. |
| Modelos desconhecidos | `codex-rs/models-manager/src/model_info.rs` (`model_info_from_slug`) | Metadados de fallback: shell `UnifiedExec` (`exec_command`/`write_stdin`), **sem** ferramenta `apply_patch` dedicada. |
| Ferramentas | `codex-rs/core/src/tools/handlers/*` | `exec_command` intercepta `apply_patch <<'EOF' … EOF` (`intercept_apply_patch`) e aplica o patch com a maquinaria nativa. |
| Itens de histórico | `codex-rs/protocol/src/models.rs` | O Codex é *stateless* com provedores customizados (`store: false`): reenvia todo o histórico, inclusive itens `reasoning` com `encrypted_content`. |
| Sandbox / permissões | `codex-rs/linux-sandbox/src/seccomp.rs`, `core/src/tools/sandboxing.rs` | `workspace-write` + bwrap/seccomp; com rede desligada, o seccomp bloqueia `bind/listen/connect/getsockopt/setsockopt` (ver §5). |
| MCP | `codex-rs/codex-mcp` | Ferramentas MCP chegam ao provedor como `{"type":"namespace","name":"mcp__<servidor>"}`. |

Isso foi verificado **empiricamente** com um servidor falso que capturou as requisições reais do Codex
0.166.0 e devolveu chamadas roteirizadas (execução, `apply_patch` e escrita fora do workspace bloqueada).

## 2. Decisão arquitetural: camada de compatibilidade, sem fork

O Codex só fala a Responses API e espera tool calling nativo. O Qwen3.8-27B OBLITERATED na Opper
(`heabsy/qwen38-obl`) tem só a capacidade `text`: **não tem tool calling nativo**. Avaliei duas opções:

1. **Fork do Codex** (alterar `codex-rs/core` para interpretar JSON em texto). Daria acoplamento a
   detalhes internos em Rust que mudam a cada release, build pesado e atualização difícil.
2. **Proxy de compatibilidade (escolhida)**: um servidor local (`qwen-bridge`) se apresenta ao Codex
   como provedor Responses API. Ele converte o histórico para Chat Completions, aplica o protocolo
   JSON, valida e devolve **chamadas de ferramenta nativas** ao Codex.

Com a opção 2, **nenhuma linha do Codex é alterada**. A interface, as sessões, o sandbox, a execução,
o `apply_patch` e o MCP são todos do Codex original. Para atualizar o Codex basta mudar a versão
no `package.json` e rodar os testes (`npm test` e `scripts/e2e-docker-mock.sh`).

```
Usuário
  │
  ▼
Codex CLI 0.166.0 (TUI/exec, sessões, sandbox, execução, apply_patch, MCP)
  │  POST /v1/responses (SSE)                ▲ function_call / message
  ▼                                          │
qwen-bridge ──────────────────────────────────┘
  1. converte histórico Codex → mensagens Chat Completions (protocolo JSON + catálogo)
  2. chama o Qwen (Opper /v3/compat/chat/completions)
  3. parser determinístico (JSON) ─► inválido? PROTOCOL_ERROR ao modelo (máx. N tentativas)
  4. validação por JSON Schema (ajv) ─► inválido? idem
  5. política determinística (caminhos, comandos, segredos) ─► negado? POLICY_DENIED ao modelo
  6. ação destrutiva/externa? ─► suspende e pede "autorizo <código>" ao usuário
  7. tradução para ferramenta nativa do Codex (exec_command / apply_patch / write_stdin / MCP)
  │
  ▼
Executor = Codex (terminal, arquivos, testes, builds, processos, Playwright MCP)
  │  resultado (stdout+stderr, exit code, duração) volta no próximo POST
  ▼
qwen-bridge → TOOL_RESULT → Qwen escolhe o próximo passo
```

O Qwen é o **único** modelo envolvido. Parser, validador, política e tradutor são código determinístico.
O modelo nunca decide as próprias permissões.

## 3. Protocolo

Toda resposta do modelo deve ser **um** objeto JSON:

```json
{"type":"tool_call","thought":"por que","tool":"terminal.execute","arguments":{"command":"npm test"}}
{"type":"message","content":"texto para o usuário (encerra o turno)"}
```

Tolerâncias determinísticas (registradas no log como `protocol_note`): remoção de `<think>…</think>`,
extração de bloco ```` ```json ````, texto fora do JSON ignorado e `type` inferido quando há `tool`.
Não há "conserto" heurístico de JSON quebrado: o erro volta ao modelo como `PROTOCOL_ERROR` e o
modelo tenta de novo, até `BRIDGE_MAX_REPAIRS` vezes (padrão 3). Texto sem nenhum `{` é tratado como
mensagem comum ao usuário.

Os resultados voltam ao modelo como mensagens `TOOL_RESULT` legíveis:

```
TOOL_RESULT ferramenta=terminal.execute
status=error exit_code=1 duracao_s=0.17
--- saída ---
...
--- fim ---
```

**Estado sem servidor.** O bridge não guarda estado entre requisições. A chamada original do modelo
(ex.: `file.patch` com `old_text`/`new_text`) vai num item `reasoning.encrypted_content`, que o Codex
devolve no histórico. Assim o bridge reconstrói a conversa no formato do protocolo mesmo depois de
reiniciar.

## 4. Ferramentas (catálogo do modelo → executor do Codex)

| Ferramenta do Qwen | Tradução determinística |
|---|---|
| `file.read` | `exec_command`: `awk` com números de linha (paginação `start_line`/`end_line`) |
| `file.list` | `exec_command`: `find -maxdepth N` (ignora `node_modules`, `.git`, …) |
| `file.search` | `exec_command`: `grep -rnI -F/-E` (exclui `.env*`) |
| `file.write` | `exec_command`: `apply_patch` com `*** Add File` (cria/sobrescreve) |
| `file.patch` | o bridge lê o arquivo, exige `old_text` único, gera hunk `*** Update File` com contexto → `apply_patch` |
| `file.delete` | `rm -- <arquivo>` (**sempre** exige autorização explícita) |
| `terminal.execute` | `exec_command` (timeout ≤ 30 s por espera; se continuar rodando vira sessão) |
| `process.start` / `process.read` / `process.stop` | `exec_command` com TTY / `write_stdin` (leitura de logs / Ctrl+C) |
| `browser.*` | ferramentas do `@playwright/mcp` (subconjunto permitido; sem execução de JS arbitrário) |

Todos os argumentos de shell são escapados com aspas simples POSIX; nada do modelo é interpolado
sem escape, exceto `terminal.execute`/`process.start`, cujo propósito é executar o comando
(depois de passar pela política).

## 5. Segurança e isolamento

Camadas, da mais interna para a mais externa:

1. **Política do bridge** (`bridge/src/policy.mjs`): confinamento ao workspace (inclusive via symlink),
   bloqueio de `.env`, `.git/`, `.ssh/`, chaves e credenciais. Comandos **negados** (sudo, `rm -rf /`,
   despejo de variáveis de ambiente, `curl | sh`, docker, ssh, `git push --force` etc.) e comandos que
   **exigem autorização** (rm, instalação de dependências, npx, git push/reset, rede externa, kill).
   As regras de comando são heurísticas (regex) e servem como defesa em profundidade.
2. **Autorização explícita** (`autorizo <código>`): a ação fica suspensa e o turno termina. O código
   só é aceito numa mensagem real do usuário (item `role=user` do Codex). Resultados de ferramentas,
   arquivos e páginas não conseguem forjá-lo, e uma ação *negada* nunca pode ser autorizada.
3. **Codex**: o `shell_environment_policy` não repassa variáveis `*KEY*`/`*TOKEN*`/`OPPER_*` aos
   comandos. O Codex nunca recebe a `OPPER_API_KEY`, só um token local aleatório do bridge.
4. **Container** (modo recomendado, `docker/compose.yml`):
   - `agent` (Codex + workspace): rootfs somente leitura, `cap_drop: ALL`, `no-new-privileges`,
     limite de PIDs, memória e CPU, e rede **interna** sem internet. Só o workspace é gravável.
   - `bridge`: único com saída para a internet e único com a chave. Monta o workspace **somente leitura**.

Instruções encontradas em arquivos, logs ou páginas são tratadas como dados. O prompt diz isso ao
modelo, mas a garantia real vem das camadas acima, que não dependem do modelo.

### Por que o sandbox do Codex fica desligado dentro do container

- O sandbox Linux do Codex (bwrap) precisa de *user namespaces*, que o seccomp padrão do Docker bloqueia.
  Medido aqui: `bwrap: No permissions to create a new namespace`. Para funcionar seria preciso
  `seccomp=unconfined`, o que **enfraquece** o container.
- Com a rede desligada, o filtro seccomp do Codex bloqueia `getsockopt/setsockopt/bind/listen`. Na prática:
  - o `node --test` perde o detalhe dos subtestes (o modelo vê só "test failed", sem o nome do teste);
  - servidores locais não conseguem escutar.

  Os dois efeitos foram reproduzidos com `codex sandbox -- npm test`.

Por isso, no container, o próprio container é o sandbox (`danger-full-access` do Codex dentro de um
container endurecido e sem internet). No modo local (sem Docker), o sandbox `workspace-write` do
Codex continua ativo, com as limitações acima documentadas.

## 6. Observabilidade

`logs/bridge-AAAA-MM-DD.jsonl` (todas as sessões) e `logs/sessions/<sessão>.jsonl`. Eventos registrados:

| Evento | Conteúdo |
|---|---|
| `turn_request` | passo atual, política de aprovação, ferramentas oferecidas |
| `model_request` | **prompt completo** enviado (desligável com `BRIDGE_LOG_PROMPTS=none`) |
| `model_response` | resposta bruta, latência, `usage`, `cost_usd` (preço do catálogo público da Opper) |
| `tool_call` | ferramenta, argumentos validados e tradução para o Codex |
| `tool_result` | status, exit code, duração, tamanho da saída |
| `protocol_error` | categoria `parser` / `validation` / `policy` / `loop` / `limit` / `repair_exhausted` |
| `api_error` | falhas HTTP/rede do provedor (categoria `api`) |
| `approval_requested` / `approval_granted` | autorizações explícitas |

Chaves são mascaradas (`[REDACTED]`) antes de gravar. `npm run logs -- <dir> --timeline` mostra uma
linha do tempo e diz se uma falha foi do **modelo** (parser/validação/loop), da **API**, da **política**
ou da **ferramenta** (exit code ≠ 0).

## 7. Windows 11: nativo, WSL2 ou Docker?

O Codex 0.166.0 tem binários para Windows, mas o sandbox nativo do Windows é outro mecanismo e o
projeto depende de bash (`apply_patch` via heredoc, `awk`, `grep`). **Recomendação: Docker Desktop
com backend WSL2.** Os motivos:

- reprodutível (imagem fixa);
- não exige Node/npm no Windows;
- isola a máquina do usuário de verdade (rede interna, rootfs somente leitura, só o workspace montado);
- a chave fica num container separado.

O modo **WSL2 sem Docker** (`scripts/setup.sh` + `scripts/agent.sh`) também funciona e usa o sandbox do
Codex, mas o WSL monta `C:\` em `/mnt/c`: comandos de leitura do agente alcançam arquivos do Windows.
Por isso esse modo serve apenas para desenvolvimento do bridge.
