// Logs estruturados (JSONL) + saída legível no console. Nunca grava segredos.
import fs from 'node:fs';
import path from 'node:path';

const SECRET_PATTERNS = [
  /\bop-[A-Za-z0-9_\-]{8,}/g, // chaves Opper
  /\bsk-[A-Za-z0-9_\-]{16,}/g, // chaves estilo OpenAI
  /(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi,
];

export function makeRedactor(secrets = []) {
  const literal = secrets.filter((s) => typeof s === 'string' && s.length >= 6);
  return function redact(value) {
    if (value == null) return value;
    if (typeof value === 'string') {
      let out = value;
      for (const s of literal) out = out.split(s).join('[REDACTED]');
      for (const re of SECRET_PATTERNS) out = out.replace(re, (m, p1) => (typeof p1 === 'string' && /bearer/i.test(p1) ? `${p1}[REDACTED]` : '[REDACTED]'));
      return out;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (typeof value === 'object') {
      const o = {};
      for (const [k, v] of Object.entries(value)) {
        if (/^(authorization|api[_-]?key|x-api-key)$/i.test(k)) o[k] = '[REDACTED]';
        else o[k] = redact(v);
      }
      return o;
    }
    return value;
  };
}

const COLORS = { api: 31, parser: 33, validation: 33, policy: 35, tool: 36, model: 32, info: 90 };

export class Logger {
  constructor({ dir, secrets = [], console: useConsole = true, logPrompts = true }) {
    this.dir = dir;
    this.redact = makeRedactor(secrets);
    this.useConsole = useConsole;
    this.logPrompts = logPrompts;
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    this.mainFile = path.join(dir, `bridge-${day}.jsonl`);
  }

  /**
   * Registra um evento.
   * @param {string} event nome do evento (ex.: model_request, tool_call, protocol_error)
   * @param {object} data dados do evento; `session` direciona também ao arquivo da sessão
   */
  log(event, data = {}) {
    const rec = this.redact({ ts: new Date().toISOString(), event, ...data });
    const line = JSON.stringify(rec) + '\n';
    try {
      fs.appendFileSync(this.mainFile, line);
      if (rec.session) {
        const safe = String(rec.session).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
        fs.appendFileSync(path.join(this.dir, 'sessions', `${safe}.jsonl`), line);
      }
    } catch (e) {
      process.stderr.write(`[bridge] falha ao gravar log: ${e.message}\n`);
    }
    if (this.useConsole) this.printHuman(rec);
    return rec;
  }

  printHuman(rec) {
    const cat = rec.category || (rec.event.startsWith('model') ? 'model' : rec.event.startsWith('tool') ? 'tool' : 'info');
    const color = COLORS[cat] || 0;
    let summary = '';
    switch (rec.event) {
      case 'turn_request':
        summary = `turno: ${rec.items} itens, passo ${rec.step}/${rec.max_steps}`;
        break;
      case 'model_request':
        summary = `→ modelo (tentativa ${rec.attempt}, ${rec.message_count} msgs, ~${rec.prompt_chars} chars)`;
        break;
      case 'model_response':
        summary = `← modelo ${rec.latency_ms}ms tokens in=${rec.usage?.prompt_tokens ?? '?'} out=${rec.usage?.completion_tokens ?? '?'}${rec.cost_usd != null ? ` custo≈$${rec.cost_usd.toFixed(6)}` : ''}`;
        break;
      case 'tool_call':
        summary = `ferramenta ${rec.tool} ${JSON.stringify(rec.arguments).slice(0, 160)}`;
        break;
      case 'tool_result':
        summary = `resultado ${rec.tool} status=${rec.status} exit=${rec.exit_code ?? '-'} ${rec.duration_s ?? '-'}s`;
        break;
      case 'protocol_error':
        summary = `ERRO[${rec.category}] ${rec.detail}`.slice(0, 300);
        break;
      case 'final_message':
        summary = `mensagem ao usuário (${rec.chars} chars)`;
        break;
      case 'api_error':
        summary = `ERRO[api] ${rec.detail}`.slice(0, 300);
        break;
      default:
        summary = rec.detail || '';
    }
    process.stderr.write(`\x1b[${color}m[bridge ${rec.ts.slice(11, 19)}] ${rec.event}\x1b[0m ${summary}\n`);
  }
}
