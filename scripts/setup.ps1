# Prepara o projeto no Windows 11 (modo recomendado: Docker Desktop + WSL2).
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
docker version | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop não encontrado/ativo.' }
if (-not (Test-Path '.env')) { Copy-Item '.env.example' '.env'; Write-Host '[setup] criado .env — preencha OPPER_API_KEY.' }
New-Item -ItemType Directory -Force -Path logs\playwright, workspace | Out-Null
# O compose.yml exige estas variáveis ao interpolar o arquivo, mesmo no build. Valores só para este processo.
if (-not $env:QWEN_BRIDGE_TOKEN) { $env:QWEN_BRIDGE_TOKEN = 'build-only' }
if (-not $env:AGENT_WORKSPACE) { $env:AGENT_WORKSPACE = (Resolve-Path 'workspace').Path }
docker compose -f docker\compose.yml build
if ($LASTEXITCODE -ne 0) { throw 'falha no build da imagem' }
# testes unitários do bridge dentro do container (não exige Node no Windows)
docker run --rm qwen-agent:local npm test
if ($LASTEXITCODE -ne 0) { throw 'falha nos testes unitários' }
Write-Host '[setup] ok. Próximos passos: .\scripts\prepare-workspace.ps1 discount-bug ; .\scripts\check-api.ps1'
