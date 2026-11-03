# Relatório de testes — POC Codex CLI + Qwen Obliterated

Data: 2026-11-03. Ambiente de validação: container Linux x86_64 em nuvem com Docker 29.9 e Node 22.23,
Codex CLI `@openai/codex@0.166.0`.

> **Resumo honesto.**
> 1. A cadeia completa foi validada com respostas **simuladas** (local e Docker, testes 1 e 2).
> 2. Com a chave real da Opper, o modelo-alvo `heabsy/qwen38-obl` (Qwen3.8-27B OBLITERATED) respondeu
>    **HTTP 403 `entitlement_required`**: o modelo é restrito e a liberação é pedida em hello@opper.ai.
>    O mesmo vale para todos os modelos do grupo `abliterated`.
> 3. Como linha de base, os dois testes foram executados **com API real** usando o **Qwen3.8-27B original**
>    (`multiverse:eu/qwen3.8-27b`), o modelo-base do Obliterated, também sem tool calling usado aqui.
>    Os dois passaram com verificação independente (seção 3b).
> 4. **O comportamento do Obliterated em si ainda não foi medido.** Depois que o acesso for liberado,
>    rode `scripts/real-test.sh` sem `OPPER_MODEL` e compare com a linha de base.

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

## 3b. Testes com API REAL: Qwen3.8-27B original (linha de base)

Comando: `OPPER_MODEL=multiverse:eu/qwen3.8-27b scripts/real-test.sh <cenário>`, executado na topologia
Docker (agente sem internet, chave só no bridge). Parâmetros: temperatura 0,2, `max_tokens` 2048 e
protocolo no papel `system`. O custo é o **informado pela Opper** em `usage.cost`. Evidências em
`docs/results/`.

### Primeiro teste (`discount-bug`): SUCESSO

| # | Critério | Resultado | Evidência |
|---|---|---|---|
| 1 | Analisou o projeto | ✅ | `file.list`, `file.read` em package.json, src/discount.ts e test/discount.test.ts |
| 2 | Pediu ferramenta por JSON | ✅ | 8/8 respostas em JSON válido na 1ª tentativa (0 erros de parser/validação) |
| 3 | Executor executou | ✅ | 7 `tool_result` (6 ok + o `npm test` inicial com exit 1) |
| 4 | Resultado voltou ao modelo | ✅ | o `thought` do patch cita a regra "a partir de R$ 100 (inclusive)" |
| 5 | Identificou o bug | ✅ | `>` em vez de `>=` na linha 20 |
| 6 | Solicitou a edição | ✅ | `file.patch` → `apply_patch` do Codex |
| 7 | Reexecutou os testes | ✅ | `npm test` → exit 0 |
| 8 | Testes passam (fora do agente) | ✅ | **6 pass / 0 fail**; diff de 1 linha |
| 9 | Resumo ao usuário | ✅ | causa, alteração (arquivo/linha) e validação |

Métricas: 8 chamadas ao modelo, latência média de 1,1 s, 28.561 tokens de entrada / 988 de saída,
**custo US$ 0,00144**, 14 s de execução.

### Segundo teste (`web-form-bug`, navegador): SUCESSO

O modelo leu o código e iniciou o servidor. Depois abriu a página, usou o `browser.snapshot` para obter
as refs (`e4`/`e5`/`e6`), digitou os valores, clicou e leu o `TypeError` no console. Em seguida corrigiu
`#total-value` → `#total` com `file.patch`, recarregou, refez a interação (novas refs `f1e4`…) e
confirmou `R$ 39,80` sem erros. Por fim encerrou o servidor e ainda conferiu com `curl` que a porta
não respondia mais.

Verificação independente com Playwright fora do agente: `total exibido: "R$ 39,80" | erros de página: nenhum`.
Métricas: 23 chamadas, 0 erros de protocolo, 142.907 tokens de entrada / 2.128 de saída,
**custo US$ 0,00495**, cerca de 35 s.

**Observações:**
- o modelo-base às vezes gera alguns tokens de raciocínio (`reasoning_tokens` 7–148) antes do JSON;
  isso não afetou o protocolo;
- o contexto cresce rápido com snapshots do navegador (143k tokens de entrada no teste 2). A compactação
  de resultados antigos (`BRIDGE_KEEP_FULL_RESULTS`) segurou o custo, mas é o principal fator de custo
  e latência.

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
| **Comportamento do Qwen3.8-27B OBLITERATED** | HTTP 403 `entitlement_required`: pedir liberação a hello@opper.ai. Depois rodar `scripts/real-test.sh` (sem `OPPER_MODEL`) |
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
