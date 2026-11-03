#!/usr/bin/env bash
# Teste ponta a ponta SEM API real: Codex CLI real + qwen-bridge real + "Qwen" simulado (roteiro).
# Valida o encanamento: protocolo, parser, validação, política, tradução para o Codex,
# execução real dos comandos/patches e o retorno dos resultados ao "modelo".
# Uso: scripts/e2e-mock.sh [cenario]   (padrão: discount-bug)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="${1:-discount-bug}"
SCENARIO="$ROOT/mock/scenarios/$NAME.json"
RUN="$ROOT/.run/e2e-$NAME-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RUN"
MOCK_PORT="${MOCK_PORT:-18901}"
export BRIDGE_PORT="${E2E_BRIDGE_PORT:-18902}"

WS="$("$ROOT/scripts/prepare-workspace.sh" "$NAME" "$RUN/workspace")"
echo "== workspace: $WS"
echo "== estado inicial:"
(cd "$WS" && npm test 2>&1 | grep -E '^# (pass|fail)') || true

MOCK_TRANSCRIPT="$RUN/mock-transcript.jsonl" node "$ROOT/mock/mock-qwen.mjs" "$SCENARIO" "$MOCK_PORT" 2>"$RUN/mock.log" &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null || true' EXIT
sleep 0.5

# O bridge usa o mock como "provedor"; nada de chave real.
export BRIDGE_ENV_FILE="/dev/null"
export OPPER_BASE_URL="http://127.0.0.1:$MOCK_PORT/v1"
export OPPER_API_KEY="mock-key-not-secret"
export OPPER_MODEL="heabsy/qwen38-obl"
export OPPER_PRICE_INPUT_PER_MTOK="${OPPER_PRICE_INPUT_PER_MTOK:-0.17}"
export OPPER_PRICE_OUTPUT_PER_MTOK="${OPPER_PRICE_OUTPUT_PER_MTOK:-1.19}"
export BRIDGE_LOG_DIR="$RUN/logs"
export CODEX_HOME="$RUN/codex-home"
export AGENT_WORKSPACE="$WS"

TASK="Investigue por que os testes deste projeto estão falhando. Leia o código, execute os testes, identifique a causa, implemente uma correção mínima e execute os testes novamente. Ao terminar, explique o problema e as alterações realizadas."
set +e
timeout 300 "$ROOT/scripts/agent.sh" exec "$TASK" >"$RUN/codex-output.txt" 2>&1
CODEX_EXIT=$?
set -e
cp "$ROOT/logs/bridge-console.log" "$RUN/bridge-console.log" 2>/dev/null || true

echo "== saída do Codex (exit=$CODEX_EXIT): $RUN/codex-output.txt"
tail -n 15 "$RUN/codex-output.txt"
echo "== status do mock:"
STATUS="$(curl -fsS "http://127.0.0.1:$MOCK_PORT/status")"
echo "$STATUS"
echo "== diff aplicado pelo agente:"
(cd "$WS" && git --no-pager diff --stat && git --no-pager diff)
echo "== verificação independente (fora do agente):"
RESULT="$(cd "$WS" && npm test 2>&1 | grep -E '^# (pass|fail)')"
echo "$RESULT"
node "$ROOT/scripts/summarize-log.mjs" "$RUN/logs" || true

FAIL=0
echo "$STATUS" | grep -q '"failures":\[\]' || { echo "FALHA: o roteiro do mock não foi seguido"; FAIL=1; }
echo "$RESULT" | grep -q '# fail 0' || { echo "FALHA: os testes do workspace não passam"; FAIL=1; }
[[ $CODEX_EXIT -eq 0 ]] || { echo "FALHA: codex terminou com código $CODEX_EXIT"; FAIL=1; }
if [[ $FAIL -eq 0 ]]; then echo "E2E MOCK: SUCESSO ($RUN)"; else echo "E2E MOCK: FALHOU ($RUN)"; exit 1; fi
