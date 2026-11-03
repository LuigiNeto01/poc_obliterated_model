#!/usr/bin/env bash
# E2E SEM API real, na topologia de containers (bridge ↔ agent em rede interna + mock do Qwen).
# Uso: scripts/e2e-docker-mock.sh [cenario]   (padrão: discount-bug)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="${1:-discount-bug}"
export MOCK_SCENARIO="$NAME"
RUN="$ROOT/.run/e2e-docker-$NAME-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RUN"
WS="$("$ROOT/scripts/prepare-workspace.sh" "$NAME" "$RUN/workspace")"
export AGENT_WORKSPACE="$WS"
export QWEN_BRIDGE_TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
export AGENT_UID="$(id -u)" AGENT_GID="$(id -g)"
rm -f "$ROOT/logs/mock-transcript.jsonl"
mkdir -p "$ROOT/logs/playwright" "$ROOT/.codex-home-docker"
COMPOSE=(docker compose -f "$ROOT/docker/compose.yml" -f "$ROOT/docker/compose.mock.yml")
cleanup() { "${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

TASK="${E2E_TASK:-Investigue por que os testes deste projeto estão falhando. Leia o código, execute os testes, identifique a causa, implemente uma correção mínima e execute os testes novamente. Ao terminar, explique o problema e as alterações realizadas.}"
set +e
timeout 600 "${COMPOSE[@]}" run --rm -T agent exec "$TASK" >"$RUN/codex-output.txt" 2>&1
CODEX_EXIT=$?
set -e
echo "== saída do Codex (exit=$CODEX_EXIT):"
tail -n 12 "$RUN/codex-output.txt"
"${COMPOSE[@]}" logs bridge >"$RUN/bridge.log" 2>&1 || true
STATUS="$(grep -c MOCK_EXPECTATION_FAILED "$ROOT/logs/mock-transcript.jsonl" || true)"
echo "== diff:"
(cd "$WS" && git --no-pager diff --stat)
RESULT="$(cd "$WS" && npm test 2>&1 | grep -E '^# (pass|fail)' || true)"
echo "== verificação independente: $RESULT"
FAIL=0
[[ "$STATUS" == "0" ]] || { echo "FALHA: roteiro do mock não seguido (ver logs/mock-transcript.jsonl)"; FAIL=1; }
echo "$RESULT" | grep -q '# fail 0' || { echo "FALHA: testes não passam"; FAIL=1; }
[[ $CODEX_EXIT -eq 0 ]] || { echo "FALHA: codex saiu com $CODEX_EXIT"; FAIL=1; }
cp "$ROOT/logs/mock-transcript.jsonl" "$RUN/" 2>/dev/null || true
if [[ $FAIL -eq 0 ]]; then echo "E2E DOCKER MOCK: SUCESSO ($RUN)"; else echo "E2E DOCKER MOCK: FALHOU ($RUN)"; exit 1; fi
