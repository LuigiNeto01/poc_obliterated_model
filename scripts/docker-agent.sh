#!/usr/bin/env bash
# Inicia o agente em containers isolados (Linux / WSL2 / macOS). No Windows use scripts/agent.ps1.
#
# Uso:
#   scripts/docker-agent.sh <workspace>                 # sessão interativa (TUI do Codex)
#   scripts/docker-agent.sh <workspace> exec "tarefa"   # execução autônoma
# Variáveis: BRIDGE_ENABLE_BROWSER=1, INSTALL_BROWSER=0 (imagem sem Chromium), REBUILD=1
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WS="${1:?informe o diretório do workspace (ex.: workspace/discount-bug)}"
shift
export AGENT_WORKSPACE="$(cd "$WS" && pwd)"
[[ "$AGENT_WORKSPACE" != "$ROOT" ]] || { echo "use um workspace separado do repositório da POC" >&2; exit 1; }
[[ -f "$ROOT/.env" ]] || echo "[docker-agent] aviso: $ROOT/.env não existe (copie .env.example e preencha OPPER_API_KEY)" >&2
export QWEN_BRIDGE_TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
export AGENT_UID="${AGENT_UID:-$(id -u)}" AGENT_GID="${AGENT_GID:-$(id -g)}"
if [[ -z "${OPPER_MODEL:-}" && -f "$ROOT/.env" ]]; then
  OPPER_MODEL="$(grep -E '^OPPER_MODEL=' "$ROOT/.env" | tail -n1 | cut -d= -f2- || true)"
  export OPPER_MODEL
fi
mkdir -p "$ROOT/logs/playwright" "$ROOT/.codex-home-docker"
COMPOSE=(docker compose -f "$ROOT/docker/compose.yml")
if [[ "${REBUILD:-0}" == "1" ]] || ! docker image inspect qwen-agent:local >/dev/null 2>&1; then
  "${COMPOSE[@]}" build
fi
cleanup() { "${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT
RUN_FLAGS=(--rm)
[[ -t 0 && -t 1 ]] || RUN_FLAGS+=(-T)
"${COMPOSE[@]}" run "${RUN_FLAGS[@]}" agent "$@"
