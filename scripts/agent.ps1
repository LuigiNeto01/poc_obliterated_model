<#
.SYNOPSIS
  Inicia o agente experimental (Codex CLI + Qwen Obliterated) em containers isolados no Windows 11.

.DESCRIPTION
  Requer Docker Desktop com backend WSL2. A chave da Opper fica apenas no container do bridge
  (lida de .env). O container do agente não tem acesso à internet nem à chave.

.EXAMPLE
  .\scripts\agent.ps1 -Workspace .\workspace\discount-bug
  .\scripts\agent.ps1 -Workspace .\workspace\discount-bug -Exec "Investigue por que os testes falham..."
  .\scripts\agent.ps1 -Workspace .\workspace\web-form-bug -Browser
#>
param(
  [Parameter(Mandatory = $true)][string]$Workspace,
  [string]$Exec,
  [switch]$Browser,
  [switch]$Rebuild
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$env:AGENT_WORKSPACE = (Resolve-Path $Workspace).Path
if ($env:AGENT_WORKSPACE -eq $Root) { throw 'Use um workspace separado do repositório da POC.' }
if (-not (Test-Path (Join-Path $Root '.env'))) { Write-Warning '.env não encontrado: copie .env.example para .env e preencha OPPER_API_KEY.' }

$bytes = New-Object byte[] 24
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$env:QWEN_BRIDGE_TOKEN = -join ($bytes | ForEach-Object { $_.ToString('x2') })
$env:AGENT_UID = '1000'; $env:AGENT_GID = '1000'
$env:BRIDGE_ENABLE_BROWSER = if ($Browser) { '1' } else { '0' }
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'logs\playwright'), (Join-Path $Root '.codex-home-docker') | Out-Null

$compose = @('compose', '-f', (Join-Path $Root 'docker\compose.yml'))
docker image inspect qwen-agent:local *> $null
if ($Rebuild -or $LASTEXITCODE -ne 0) { docker @compose build; if ($LASTEXITCODE -ne 0) { throw 'falha no build' } }
try {
  if ($Exec) { docker @compose run --rm agent exec $Exec }
  else { docker @compose run --rm agent }
} finally {
  docker @compose down --remove-orphans *> $null
}
