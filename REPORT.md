# Relatório de testes — POC Codex CLI + Qwen Obliterated

Data: 2026-11-03. Ambiente de validação: container Linux x86_64 em nuvem com Docker 29.9 e Node 22.23,
Codex CLI `@openai/codex@0.166.0`.

> **Resumo honesto.** Toda a cadeia (Codex real → bridge → modelo → executor do Codex → resultado →
> modelo) foi validada com **respostas simuladas** do modelo, nos modos local e Docker, incluindo o teste
> de navegador. O **teste com o Qwen real NÃO foi executado**: nenhuma `OPPER_API_KEY` estava
> disponível neste ambiente. Portanto **ainda não há medição da competência do modelo**. O teste real
> está preparado (`scripts/real-test.sh` / `.ps1`) e a seção 6 traz o modelo de relatório a preencher.

## 1. Verificações de viabilidade (fatos medidos)

| Verificação | Resultado |
|---|---|
| Protocolos de API do Codex 0.166.0 | Só a Responses API (`wire_api = "chat"` foi removido no código). Confirmado no código e por captura de requisição. |
| Ferramentas oferecidas a modelo desconhecido | `exec_command`, `write_stdin`, `view_image`, `request_user_input`, sub-agentes e metas (estes dois últimos desligados na config). Não há `apply_patch` dedicado, mas `exec_command` intercepta `apply_patch <<EOF`. |
| Histórico | Stateless; itens `reasoning.encrypted_content` voltam intactos. Testado com servidor falso. |
| Modelo na Opper | `heabsy/qwen38-obl`, capacidades **só `text`**, contexto 524k, saída 32k, US$ 0,17 / 1,19 por Mtok, grupo de acesso `abliterated`. Fonte: catálogo público. |
| Endpoint/autenticação Opper | `https://api.opper.ai/v3/compat/chat/completions` com Bearer. Chamada real com chave inválida → **HTTP 401** do provedor ("invalid bearer token"), o que confirma endpoint e formato. |
| Sandbox do Codex (modo local) | Escrita fora do workspace bloqueada (`touch /home/user/outside.txt` → `Read-only file system`). |
| Limitação do sandbox do Codex | Com a rede desligada, o seccomp bloqueia `getsockopt/setsockopt/bind/listen`. Reproduzido com `codex sandbox -- npm test`: o `node --test` perde os nomes dos subtestes e o `spawnSync` com pipes retorna `EPERM`. |
| Sandbox do Codex dentro do Docker | `bwrap: No permissions to create a new namespace` com o seccomp padrão do Docker. Motivou a decisão "o container é o sandbox". |
| Isolamento do container do agente | Sem internet (`curl https://api.opper.ai` → falha de DNS/conexão), bridge acessível (`/health` 200), `OPPER_API_KEY` ausente do ambiente, rootfs somente leitura (`touch /etc/x` → `Read-only file system`). |
| Travamento intermitente do `codex exec` | Causa: com prompt posicional e stdin não-TTY, o `codex exec` espera EOF do stdin (`codex-rs/exec/src/lib.rs`). Corrigido com `</dev/null` nos scripts. |

## 2. Testes unitários do bridge

`npm test` → **45 testes, 45 passam**, tanto no host quanto dentro da imagem Docker. Cobrem:

- **parser:** JSON válido, `<think>`, markdown, JSON quebrado/truncado, texto livre;
- **validação por schema**, inclusive limites numéricos e propriedades extras;
- **política:** fuga por `..`, caminho absoluto, `~` e symlink; `.env`, `.git` e chaves; 15 comandos negados e 8 que exigem autorização;
- **tradução:** `file.read`/`write`/`patch` → `apply_patch`, contexto único, `replace_all`;
- **normalização** das saídas do Codex/MCP;
- **ciclo de correção de formato** e esgotamento de tentativas;
- **autorização explícita:** negar, código errado e código certo; ação negada nunca autorizável;
- detecção de loop, limite de passos, erro de API categorizado;
- **redação da chave nos logs**, formato SSE e token do bridge.

## 3. Primeiro teste com modelo simulado: `discount-bug`

Roteiro em `mock/scenarios/discount-bug.json`. O mock confere, a cada passo, se o resultado esperado
chegou ao "modelo". Todas as execuções terminaram com sucesso:

- `scripts/e2e-mock.sh`: modo local, sandbox do Codex — duas execuções;
- `scripts/e2e-docker-mock.sh`: containers, rede interna — duas execuções.

| Etapa | Evidência (logs/transcrição) |
|---|---|
| Resposta com `<think>` + bloco markdown | aceita, `protocol_note` registrado |
| `file.list` | Codex executou `find`; resultado voltou como `TOOL_RESULT` |
| `terminal.execute npm test` | `status=error exit_code=1`, `# fail 1`. No Docker o modelo também vê `not ok 2 - 10% de desconto a partir de R$ 100 (inclusive)` |
| `terminal.execute cat .env` | **bloqueado** pela política (`POLICY_DENIED`), sem chegar ao Codex |
| JSON inválido | `PROTOCOL_ERROR: JSON inválido…`, correção na tentativa seguinte |
| `file.read src/discount.ts` | conteúdo numerado devolvido |
| `file.patch` (`>` → `>=`) | `apply_patch` nativo do Codex: `Success. Updated the following files: M src/discount.ts` |
| `terminal.execute npm test` | `status=ok exit_code=0`, `# fail 0` |
| Mensagem final | exibida pelo Codex |
| **Verificação independente** | `git diff` mostra 1 linha alterada; `npm test` fora do agente: **6 pass / 0 fail** |

Métricas (modo local): 8 chamadas ao "modelo"; ferramentas: `file.list` 1, `terminal.execute` 2,
`file.read` 1, `file.patch` 1; erros: `policy` 1, `parser` 1 (ambos intencionais). Os tokens nesse
modo são **estimativas do mock** (caracteres ÷ 4), não números do provedor.

## 4. Segundo teste com modelo simulado: `web-form-bug` (navegador)

`scripts/e2e-docker-mock.sh web-form-bug` → **SUCESSO**. Linha do tempo registrada pelo bridge:

`process.start` → `browser.navigate` → `browser.snapshot` → `browser.fill_form` → `browser.click` →
`browser.console_messages` (o modelo recebeu `TypeError: Cannot set properties of null (setting 'textContent')`) →
`browser.network_requests` (`POST /api/quote` 200) → `file.search` ×2 → `file.patch` (`#total-value` → `#total`) →
`browser.navigate` → `browser.fill_form` → `browser.click` → `browser.snapshot` (`status: R$ 39,80`) →
`process.stop` → mensagem final.

**Verificação independente** com Playwright fora do agente (`scripts/verify-web-form-bug.mjs`):
`total exibido: "R$ 39,80" | erros de página: nenhum`. Antes da correção, o mesmo verificador
reportava `"—"` e o `TypeError`.

Problemas encontrados e corrigidos durante este teste:

- o Codex inicia servidores MCP com ambiente mínimo, então foi preciso repassar `PLAYWRIGHT_BROWSERS_PATH`;
- esta versão do Playwright MCP grava o snapshot de `navigate`/`click` em arquivo fora do workspace. O
  bridge agora substitui o link por "use browser.snapshot";
- uma heurística marcava respostas MCP com a palavra "errors" como falha. Foi refinada.

O `process.stop` aparece com `exit_code=1` porque o servidor termina por Ctrl+C.

## 5. O que NÃO foi validado

| Item | Motivo / como validar |
|---|---|
| **Comportamento do Qwen real** (os 9 critérios com o modelo de verdade) | Sem `OPPER_API_KEY`. Rodar `scripts/real-test.sh` ou `.\scripts\real-test.ps1` |
| Acesso ao grupo `abliterated` na conta Opper | Desconhecido; o `check-api` mostra 402/403 se faltar acesso ou crédito |
| Aceitação de `repetition_penalty` pelo provedor para este modelo | Não listado no catálogo; teste com `OPPER_EXTRA_PARAMS={"repetition_penalty":1.15}` |
| Scripts PowerShell (`*.ps1`) e Docker Desktop no Windows 11 | Não há máquina Windows/pwsh neste ambiente. Os scripts **não foram executados**; a lógica equivale aos `.sh` testados |
| TUI interativa: conversa completa | Só foi verificada a abertura da TUI no container com pseudo-terminal (prompt "Ask Codex to do anything", modelo `heabsy/qwen38-obl`) |
| Separação stdout/stderr | O executor do Codex entrega stdout+stderr combinados; o bridge reporta saída combinada, exit code e duração |

## 6. Modelo de relatório para o teste real

Preencha a tabela após rodar `scripts/real-test.sh`. Os artefatos ficam em `.run/real-discount-bug-<data>/`:
`codex-output.txt`, `diff.patch`, `verify.txt`, `session.jsonl` e `summary.txt`.

| # | Critério | Resultado | Evidência |
|---|---|---|---|
| 1 | Qwen analisou o projeto | | eventos `tool_call` iniciais |
| 2 | Pediu ferramenta por JSON estruturado | | `model_response.raw` + `tool_call` |
| 3 | Executor interpretou e executou | | `tool_result` |
| 4 | Resultado voltou ao Qwen | | `model_request.messages` contém `TOOL_RESULT` |
| 5 | Identificou o bug | | `thought` / mensagem final |
| 6 | Solicitou a edição | | `tool_call` `file.patch`/`file.write` |
| 7 | Reexecutou os testes | | `tool_call` `terminal.execute` após a edição |
| 8 | Testes passam (verificação independente) | | `verify.txt` |
| 9 | Usuário recebeu resumo | | `final_message` |

Métricas a coletar (`summary.txt`): chamadas ao modelo, erros por categoria (`parser`, `validation`, `policy`,
`loop`, `api`, `tool`), tokens reais do provedor, custo estimado e latência média.
