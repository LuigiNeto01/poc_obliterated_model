#!/usr/bin/env bash
# Inicia o agente experimental: qwen-bridge (em segundo plano) + Codex CLI apontado para ele.
#
# Uso:
#   scripts/agent.sh                      # Codex interativo (TUI) no workspace
#   scripts/agent.sh exec "tarefa..."     # execução autônoma (não interativa)
#
# Variáveis úteis:
#   AGENT_WORKSPACE   diretório onde o agente trabalha (padrão: diretório atual)
#   BRIDGE_PORT       porta local do bridge (padrão: 8787)
#   CODEX_SANDBOX     workspace-write (padrão) | read-only | danger-full-access (só dentro de container)
#   CODEX_APPROVAL    on-request (padrão no modo interativo) | never (forçado no modo exec)
#   BRIDGE_ENABLE_BROWSER=1   habilita ferramentas de navegador (Playwright MCP)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE="$(cd "${AGENT_WORKSPACE:-$PWD}" && pwd)"
PORT="${BRIDGE_PORT:-8787}"
export CODEX_HOME="${CODEX_HOME:-$ROOT/.codex-home}"
RUN_DIR="$ROOT/.run"
mkdir -p "$RUN_DIR" "$ROOT/logs"

if [[ ! -x "$ROOT/node_modules/.bin/codex" ]]; then
  echo "[agent] dependências ausentes; rode scripts/setup.sh primeiro." >&2
  exit 1
fi
if [[ "$WORKSPACE" == "$ROOT" ]]; then
  echo "[agent] AGENT_WORKSPACE aponta para o próprio repositório da POC; use um projeto separado (ex.: scripts/prepare-workspace.sh)." >&2
  exit 1
fi

MODE="interactive"
if [[ "${1:-}" == "exec" ]]; then
  MODE="exec"
  shift
fi

# Token aleatório por execução: só este Codex consegue falar com este bridge.
QWEN_BRIDGE_TOKEN="$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))")"
export QWEN_BRIDGE_TOKEN

if [[ "$MODE" == "exec" ]]; then
  export CODEX_APPROVAL="never"
else
  export CODEX_APPROVAL="${CODEX_APPROVAL:-on-request}"
fi
# OPPER_MODEL pode vir do .env; o bridge lê o .env sozinho, aqui só repassamos para o rótulo do Codex.
if [[ -z "${OPPER_MODEL:-}" && -f "$ROOT/.env" ]]; then
  OPPER_MODEL="$(grep -E '^OPPER_MODEL=' "$ROOT/.env" | tail -n1 | cut -d= -f2- || true)"
  export OPPER_MODEL
fi
node "$ROOT/scripts/write-codex-config.mjs" "$CODEX_HOME" "$PORT"

BRIDGE_CONSOLE="$ROOT/logs/bridge-console.log"
BRIDGE_PORT="$PORT" node "$ROOT/bridge/src/server.mjs" >>"$BRIDGE_CONSOLE" 2>&1 &
BRIDGE_PID=$!
cleanup() {
  kill "$BRIDGE_PID" 2>/dev/null || true
  wait "$BRIDGE_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
    echo "[agent] o bridge terminou ao iniciar; veja $BRIDGE_CONSOLE" >&2
    tail -n 20 "$BRIDGE_CONSOLE" >&2 || true
    exit 1
  fi
  sleep 0.2
done
HEALTH="$(curl -fsS "http://127.0.0.1:$PORT/health")"
echo "[agent] bridge ativo: $HEALTH" >&2
echo "[agent] logs: $ROOT/logs (console do bridge: $BRIDGE_CONSOLE)" >&2

# O Codex NÃO recebe a chave da Opper: só o token local do bridge.
CODEX_BIN="$ROOT/node_modules/.bin/codex"
if [[ "$MODE" == "exec" ]]; then
  # stdin de /dev/null: com stdin não-TTY o `codex exec` espera EOF para anexá-lo ao prompt.
  env -u OPPER_API_KEY "$CODEX_BIN" exec --skip-git-repo-check -C "$WORKSPACE" -s "${CODEX_SANDBOX:-workspace-write}" "$@" </dev/null
else
  env -u OPPER_API_KEY "$CODEX_BIN" -C "$WORKSPACE" -s "${CODEX_SANDBOX:-workspace-write}" -a "$CODEX_APPROVAL" "$@"
fi
