#!/usr/bin/env bash
# Instalação reproduzível (Linux/WSL2/macOS): dependências locais fixadas no package-lock.json.
# Nada é instalado globalmente.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<18)){console.error("Node >= 22.18 é necessário (TypeScript nativo nos testes). Versão atual: "+process.version);process.exit(1)}'
npm ci --no-audit
[[ -f .env ]] || { cp .env.example .env; echo "[setup] criado .env a partir de .env.example — preencha OPPER_API_KEY."; }
mkdir -p logs workspace
npm test
echo "[setup] ok. Próximos passos: scripts/prepare-workspace.sh discount-bug && npm run check-api"
