#!/usr/bin/env node
// Gera $CODEX_HOME/config.toml (isolado do ~/.codex do usuário) apontando o Codex para o qwen-bridge.
// Uso: node scripts/write-codex-config.mjs <codex_home> <bridge_port>
// Variáveis: OPPER_MODEL, CODEX_SANDBOX, CODEX_APPROVAL, CODEX_NETWORK_ACCESS, BRIDGE_BASE_URL,
//            BRIDGE_ENABLE_BROWSER, PLAYWRIGHT_CHROMIUM, PLAYWRIGHT_NO_SANDBOX
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [codexHome, port] = process.argv.slice(2);
if (!codexHome || !port) {
  console.error('uso: write-codex-config.mjs <codex_home> <bridge_port>');
  process.exit(2);
}
const q = (s) => JSON.stringify(String(s)); // string TOML básica (compatível com JSON)

const model = process.env.OPPER_MODEL || 'heabsy/qwen38-obl';
const sandbox = process.env.CODEX_SANDBOX || 'workspace-write';
const approval = process.env.CODEX_APPROVAL || 'on-request';
const browser = process.env.BRIDGE_ENABLE_BROWSER === '1';

let toml = `# Gerado por scripts/write-codex-config.mjs — não edite à mão.
model_provider = "qwen-bridge"
model = ${q(model)}
web_search = "disabled"
approval_policy = ${q(approval)}
sandbox_mode = ${q(sandbox)}
check_for_update_on_startup = false

[analytics]
enabled = false

# Recursos que dependem de serviços da OpenAI/GitHub (plugins, apps) ou que o bridge não expõe ao
# Qwen (sub-agentes, metas). Desligá-los evita chamadas de rede e acelera a inicialização.
[features]
plugins = false
remote_plugin = false
apps = false
multi_agent = false
goals = false
skill_mcp_dependency_install = false

# Rede para os comandos do agente. Desligada por padrão no modo local. No Docker a rede é
# isolada pelo próprio container (rede interna, sem internet), e o sandbox do Codex fica desativado.
[sandbox_workspace_write]
network_access = ${process.env.CODEX_NETWORK_ACCESS === '1' ? 'true' : 'false'}

# Os comandos executados pelo agente não herdam segredos do ambiente.
[shell_environment_policy]
inherit = "core"
exclude = ["*KEY*", "*TOKEN*", "*SECRET*", "*PASSWORD*", "OPPER_*"]

[model_providers.qwen-bridge]
name = "Qwen3.8-27B OBLITERATED (Opper) via qwen-bridge"
base_url = ${q(process.env.BRIDGE_BASE_URL || `http://127.0.0.1:${Number(port)}/v1`)}
env_key = "QWEN_BRIDGE_TOKEN"
wire_api = "responses"
request_max_retries = 1
stream_max_retries = 1
stream_idle_timeout_ms = 600000
`;

if (browser) {
  const cli = path.join(root, 'node_modules', '@playwright', 'mcp', 'cli.js');
  if (!fs.existsSync(cli)) {
    console.error('[config] @playwright/mcp não instalado; rode o setup novamente (npm install).');
    process.exit(1);
  }
  const outDir = path.join(root, 'logs', 'playwright');
  const args = ['--headless', '--isolated', '--output-dir', outDir, '--allowed-origins', 'http://localhost:*;http://127.0.0.1:*'];
  if (process.env.PLAYWRIGHT_CHROMIUM) args.push('--executable-path', process.env.PLAYWRIGHT_CHROMIUM);
  if (process.env.PLAYWRIGHT_NO_SANDBOX === '1') args.push('--no-sandbox');
  toml += `
[mcp_servers.playwright]
command = ${q(process.execPath)}
args = [${[cli, ...args].map(q).join(', ')}]
startup_timeout_sec = 60
tool_timeout_sec = 120
`;
}

fs.mkdirSync(codexHome, { recursive: true });
fs.writeFileSync(path.join(codexHome, 'config.toml'), toml);
console.error(`[config] ${path.join(codexHome, 'config.toml')} (sandbox=${sandbox}, approval=${approval}, browser=${browser ? 'on' : 'off'})`);
