# Teste REAL com o Qwen no Windows: prepara o workspace, executa o agente (sem interação) e verifica.
# Uso: .\scripts\real-test.ps1 [-Name discount-bug|web-form-bug]
param([string]$Name = 'discount-bug')
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$ws = & (Join-Path $PSScriptRoot 'prepare-workspace.ps1') -Name $Name | Select-Object -Last 1
$scenario = Get-Content (Join-Path $Root "mock\scenarios\$Name.json") -Raw | ConvertFrom-Json
$task = if ($scenario.task) { $scenario.task } else { 'Investigue por que os testes deste projeto estão falhando. Leia o código, execute os testes, identifique a causa, implemente uma correção mínima e execute os testes novamente. Ao terminar, explique o problema e as alterações realizadas.' }
$browser = $Name -like 'web-*'
& (Join-Path $PSScriptRoot 'agent.ps1') -Workspace $ws -Exec $task -Browser:$browser
Write-Host "`n== diff aplicado pelo agente"; git -C $ws --no-pager diff
Write-Host "== verificação independente"
docker run --rm -v "${ws}:/ws" -w /ws qwen-agent:local npm test
if (Test-Path (Join-Path $Root "scripts\verify-$Name.mjs")) {
  docker run --rm -e PLAYWRIGHT_NO_SANDBOX=1 -v "${ws}:/ws" qwen-agent:local node "scripts/verify-$Name.mjs" /ws
}
docker run --rm -v "$(Join-Path $Root 'logs'):/logs" qwen-agent:local node scripts/summarize-log.mjs /logs --timeline
