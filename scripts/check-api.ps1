# Verifica a chave/modelo/endpoint da Opper a partir do container do bridge (a chave não sai do .env).
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
docker run --rm --env-file (Join-Path $Root '.env') qwen-agent:local node scripts/check-api.mjs
