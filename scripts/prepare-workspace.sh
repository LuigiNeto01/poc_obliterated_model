#!/usr/bin/env bash
# Copia um projeto de exemplo para um workspace descartável (sem o README que contém a resposta)
# e inicializa um repositório git para facilitar a inspeção das alterações do agente.
#
# Uso: scripts/prepare-workspace.sh <exemplo> [destino]
#   ex.: scripts/prepare-workspace.sh discount-bug            -> workspace/discount-bug
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="${1:?informe o nome do exemplo (ex.: discount-bug)}"
SRC="$ROOT/examples/$NAME"
DEST="${2:-$ROOT/workspace/$NAME}"
[[ -d "$SRC" ]] || { echo "exemplo não encontrado: $SRC" >&2; exit 1; }
rm -rf "$DEST"
mkdir -p "$DEST"
(cd "$SRC" && tar --exclude=README.md --exclude=node_modules --exclude=test-results -cf - .) | (cd "$DEST" && tar -xf -)
(
  cd "$DEST"
  git init -q
  git add -A
  git -c user.name=poc -c user.email=poc@localhost commit -qm "estado inicial (com bug)"
)
echo "$DEST"
