// Configuração do bridge: somente variáveis de ambiente (opcionalmente carregadas de .env).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Carrega um arquivo .env simples (KEY=VALUE) sem sobrescrever variáveis já definidas. */
export function loadDotEnv(file) {
  if (!file || !fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
  }
  return true;
}

function num(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Variável ${name} deve ser numérica (recebido: ${v})`);
  return n;
}

function json(name, def) {
  const v = process.env[name];
  if (!v) return def;
  try {
    return JSON.parse(v);
  } catch (e) {
    throw new Error(`Variável ${name} deve conter JSON válido: ${e.message}`);
  }
}

export function loadConfig(env = process.env) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  return {
    root,
    opper: {
      apiKey: env.OPPER_API_KEY || '',
      baseUrl: (env.OPPER_BASE_URL || 'https://api.opper.ai/v3/compat').replace(/\/+$/, ''),
      model: env.OPPER_MODEL || 'heabsy/qwen38-obl',
      temperature: num('OPPER_TEMPERATURE', 0.2),
      maxTokens: num('OPPER_MAX_TOKENS', 2048),
      extraParams: json('OPPER_EXTRA_PARAMS', {}),
      timeoutMs: num('OPPER_TIMEOUT_MS', 180_000),
      maxRetries: num('OPPER_MAX_RETRIES', 3),
      priceInputPerMtok: env.OPPER_PRICE_INPUT_PER_MTOK ? Number(env.OPPER_PRICE_INPUT_PER_MTOK) : null,
      priceOutputPerMtok: env.OPPER_PRICE_OUTPUT_PER_MTOK ? Number(env.OPPER_PRICE_OUTPUT_PER_MTOK) : null,
      catalogUrl: env.OPPER_CATALOG_URL || 'https://api.opper.ai/v3/models',
      // "system" (padrão) ou "user": onde colocar o protocolo. O card do modelo sugere
      // evitar system prompt; deixamos configurável para medir o efeito.
      protocolRole: env.BRIDGE_PROTOCOL_ROLE === 'user' ? 'user' : 'system',
    },
    bridge: {
      host: env.BRIDGE_HOST || '127.0.0.1',
      port: num('BRIDGE_PORT', 8787),
      token: env.QWEN_BRIDGE_TOKEN || '',
      maxSteps: num('BRIDGE_MAX_STEPS', 40),
      maxRepairs: num('BRIDGE_MAX_REPAIRS', 3),
      maxResultChars: num('BRIDGE_MAX_RESULT_CHARS', 12_000),
      keepFullResults: num('BRIDGE_KEEP_FULL_RESULTS', 10),
      logDir: path.resolve(env.BRIDGE_LOG_DIR || path.join(root, 'logs')),
      // Modo internet: pasta (compartilhada com o agente) de onde o bridge lê os snapshots das páginas.
      snapshotDir: env.BRIDGE_ALLOW_INTERNET === '1' ? path.resolve(env.BRIDGE_LOG_DIR || path.join(root, 'logs'), 'playwright') : null,
      logPrompts: (env.BRIDGE_LOG_PROMPTS || 'full') !== 'none',
      // Força a política de aprovação, caso não seja possível inferi-la do Codex.
      approvalOverride: env.BRIDGE_APPROVAL_POLICY || '',
    },
  };
}
