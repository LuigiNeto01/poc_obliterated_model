#!/usr/bin/env bash
# Teste REAL com o Qwen (Opper): prepara o workspace, executa o agente sem interação dentro dos containers,
# verifica o resultado fora do agente e resume os logs. Requer OPPER_API_KEY no .env.
# Uso: scripts/real-test.sh [discount-bug|web-form-bug]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="${1:-discount-bug}"
STAMP="$(date +%Y%m%d-%H%M%S)"
RUN="$ROOT/.run/real-$NAME-$STAMP"
mkdir -p "$RUN"
grep -qE '^OPPER_API_KEY=.+' "$ROOT/.env" 2>/dev/null || { echo "Preencha OPPER_API_KEY em $ROOT/.env" >&2; exit 2; }
WS="$("$ROOT/scripts/prepare-workspace.sh" "$NAME" "$RUN/workspace")"
TASK="$(node -e 'const s=require(process.argv[1]); process.stdout.write(s.task||"")' "$ROOT/mock/scenarios/$NAME.json")"
[[ -n "$TASK" ]] || TASK="Investigue por que os testes deste projeto estão falhando. Leia o código, execute os testes, identifique a causa, implemente uma correção mínima e execute os testes novamente. Ao terminar, explique o problema e as alterações realizadas."
[[ "$NAME" == web-* ]] && export BRIDGE_ENABLE_BROWSER=1
SESSIONS_BEFORE="$(ls "$ROOT/logs/sessions" 2>/dev/null | sort || true)"

echo "== tarefa: $TASK"
set +e
timeout "${REAL_TEST_TIMEOUT:-1800}" "$ROOT/scripts/docker-agent.sh" "$WS" exec "$TASK" 2>&1 | tee "$RUN/codex-output.txt"
CODEX_EXIT=${PIPESTATUS[0]}
set -e

echo; echo "== diff aplicado pelo agente"
(cd "$WS" && git --no-pager diff) | tee "$RUN/diff.patch"
echo "== verificação independente (fora do agente)"
docker run --rm -v "$WS:/ws" -w /ws qwen-agent:local npm test 2>&1 | grep -E '^(not ok|# (pass|fail))' | tee "$RUN/verify.txt" || true
if [[ -f "$ROOT/scripts/verify-$NAME.mjs" ]]; then
  docker run --rm -e PLAYWRIGHT_NO_SANDBOX=1 -v "$WS:/ws" qwen-agent:local node "scripts/verify-$NAME.mjs" /ws | tee -a "$RUN/verify.txt" || true
fi
NEW_SESSION="$(comm -13 <(echo "$SESSIONS_BEFORE") <(ls "$ROOT/logs/sessions" | sort) | tail -n1)"
if [[ -n "$NEW_SESSION" ]]; then
  cp "$ROOT/logs/sessions/$NEW_SESSION" "$RUN/session.jsonl"
  node "$ROOT/scripts/summarize-log.mjs" "$RUN/session.jsonl" --timeline | tee "$RUN/summary.txt"
fi
echo "== artefatos: $RUN (codex exit=$CODEX_EXIT)"
