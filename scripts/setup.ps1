# Prepara o projeto no Windows 11 (modo recomendado: Docker Desktop + WSL2).
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
docker version | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop não encontrado/ativo.' }
if (-not (Test-Path '.env')) { Copy-Item '.env.example' '.env'; Write-Host '[setup] criado .env — preencha OPPER_API_KEY.' }
New-Item -ItemType Directory -Force -Path logs\playwright, workspace | Out-Null
docker compose -f docker\compose.yml build
if ($LASTEXITCODE -ne 0) { throw 'falha no build da imagem' }
# testes unitários do bridge dentro do container (não exige Node no Windows)
docker run --rm qwen-agent:local npm test
Write-Host '[setup] ok. Próximos passos: .\scripts\prepare-workspace.ps1 discount-bug ; .\scripts\check-api.ps1'
