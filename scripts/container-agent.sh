#!/usr/bin/env bash
# Entrypoint do container "agent": configura o Codex para usar o bridge e inicia a sessão.
# Dentro do container o próprio container é o sandbox (rootfs somente leitura, sem capabilities,
# rede interna sem internet); por isso o sandbox do Codex fica em danger-full-access.
set -euo pipefail
ROOT=/opt/poc
export CODEX_SANDBOX=danger-full-access
export CODEX_APPROVAL=never   # autorizações explícitas são feitas pelo qwen-bridge ("autorizo <código>")
node "$ROOT/scripts/write-codex-config.mjs" "$CODEX_HOME" 8787
git config --global --add safe.directory /workspace 2>/dev/null || true
if [[ "${1:-}" == "exec" ]]; then
  shift
  # stdin de /dev/null: com stdin não-TTY o `codex exec` espera EOF para anexá-lo ao prompt.
  exec "$ROOT/node_modules/.bin/codex" exec --skip-git-repo-check -C /workspace -s danger-full-access "$@" </dev/null
fi
exec "$ROOT/node_modules/.bin/codex" -C /workspace -s danger-full-access -a never "$@"
