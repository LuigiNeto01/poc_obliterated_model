#!/usr/bin/env node
// Resume os logs JSONL do bridge: linha do tempo por sessão, erros por categoria, tokens e custo.
// Uso: node scripts/summarize-log.mjs [diretório-de-logs | arquivo.jsonl] [--timeline]
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const timeline = args.includes('--timeline');
const target = args.find((a) => !a.startsWith('--')) || path.join(process.cwd(), 'logs');

function files(t) {
  if (!fs.existsSync(t)) return [];
  if (fs.statSync(t).isFile()) return [t];
  const s = path.join(t, 'sessions');
  if (fs.existsSync(s)) return fs.readdirSync(s).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(s, f));
  return fs.readdirSync(t).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(t, f));
}

const list = files(target);
if (!list.length) {
  console.log(`nenhum log encontrado em ${target}`);
  process.exit(0);
}

for (const f of list) {
  const events = fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const s = { model_calls: 0, tool_calls: {}, errors: {}, in: 0, out: 0, cost: 0, costKnown: true, latency: [], final: 0, results: { ok: 0, error: 0, running: 0 } };
  for (const e of events) {
    if (e.event === 'model_response') {
      s.model_calls++;
      s.in += e.usage?.prompt_tokens || 0;
      s.out += e.usage?.completion_tokens || 0;
      if (e.cost_usd == null) s.costKnown = false;
      else s.cost += e.cost_usd;
      s.latency.push(e.latency_ms);
    }
    if (e.event === 'tool_call') s.tool_calls[e.tool] = (s.tool_calls[e.tool] || 0) + 1;
    if (e.event === 'tool_result') s.results[e.status] = (s.results[e.status] || 0) + 1;
    if (e.event === 'protocol_error' || e.event === 'api_error' || e.event === 'bridge_error') s.errors[e.category] = (s.errors[e.category] || 0) + 1;
    if (e.event === 'final_message') s.final++;
  }
  const lat = s.latency.length ? Math.round(s.latency.reduce((a, b) => a + b, 0) / s.latency.length) : 0;
  console.log(`\n=== sessão ${path.basename(f, '.jsonl')} (${events.length} eventos)`);
  console.log(`chamadas ao modelo: ${s.model_calls} | latência média: ${lat} ms | tokens in/out: ${s.in}/${s.out} | custo estimado: ${s.costKnown && s.model_calls ? '$' + s.cost.toFixed(6) : 'indisponível'}`);
  console.log(`ferramentas solicitadas: ${JSON.stringify(s.tool_calls)}`);
  console.log(`resultados das ferramentas: ${JSON.stringify(s.results)}`);
  console.log(`erros por categoria: ${JSON.stringify(s.errors)} | mensagens finais: ${s.final}`);
  if (timeline) {
    for (const e of events) {
      const t = e.ts.slice(11, 19);
      if (e.event === 'tool_call') console.log(`  ${t} → ${e.tool} ${JSON.stringify(e.arguments).slice(0, 140)}`);
      else if (e.event === 'tool_result') console.log(`  ${t} ← ${e.tool} status=${e.status} exit=${e.exit_code}`);
      else if (e.event === 'protocol_error' || e.event === 'api_error') console.log(`  ${t} ✗ [${e.category}] ${String(e.detail).slice(0, 140)}`);
      else if (e.event === 'final_message') console.log(`  ${t} ✓ mensagem final (${e.chars} chars)`);
    }
  }
}
