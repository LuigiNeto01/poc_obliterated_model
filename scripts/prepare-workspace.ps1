# Copia um exemplo para workspace\<nome> (sem o README com a resposta) e cria um commit inicial.
param([Parameter(Mandatory = $true)][string]$Name)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Src = Join-Path $Root "examples\$Name"
$Dest = Join-Path $Root "workspace\$Name"
if (-not (Test-Path $Src)) { throw "exemplo não encontrado: $Src" }
if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Get-ChildItem -Force $Src | Where-Object { $_.Name -notin @('README.md', 'node_modules', 'test-results') } | Copy-Item -Destination $Dest -Recurse -Force
Push-Location $Dest
git init -q; git add -A; git -c user.name=poc -c user.email=poc@localhost commit -qm 'estado inicial (com bug)'
Pop-Location
Write-Output $Dest
