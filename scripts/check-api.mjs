#!/usr/bin/env node
// Verifica a integração real com o provedor (Opper): chave, modelo, endpoint, formato e custo.
// Faz UMA chamada pequena. Nunca imprime a chave.
// Uso: node scripts/check-api.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadDotEnv } from '../bridge/src/config.mjs';
import { chatCompletion, fetchPricing } from '../bridge/src/opper.mjs';
import { parseModelReply } from '../bridge/src/protocol.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv(process.env.BRIDGE_ENV_FILE || path.join(root, '.env'));
const cfg = loadConfig();

console.log(`endpoint : ${cfg.opper.baseUrl}/chat/completions`);
console.log(`modelo   : ${cfg.opper.model}`);
console.log(`chave    : ${cfg.opper.apiKey ? `configurada (${cfg.opper.apiKey.length} caracteres)` : 'AUSENTE'}`);
if (!cfg.opper.apiKey) {
  console.log('\nDefina OPPER_API_KEY no arquivo .env (copie de .env.example). A chave não deve ser commitada.');
  process.exit(2);
}

if (/opper\.ai/.test(cfg.opper.baseUrl)) {
  const p = await fetchPricing(cfg.opper.catalogUrl, cfg.opper.model);
  if (p) console.log(`catálogo : contexto=${p.context_window} max_saida=${p.max_output_tokens} capacidades=${(p.capabilities || []).join(',')} preço=$${p.input}/$${p.output} por Mtok grupo_de_acesso=${p.access_group || '-'}`);
  else console.log('catálogo : modelo NÃO encontrado no catálogo público (verifique OPPER_MODEL)');
}

const messages = [
  { role: 'system', content: 'Responda com EXATAMENTE UM objeto JSON e nada mais.' },
  { role: 'user', content: 'Teste de conectividade. Responda exatamente: {"type":"message","content":"ok"}' },
];
const t0 = Date.now();
try {
  const r = await chatCompletion({ ...cfg.opper, maxRetries: 1 }, messages);
  const parsed = parseModelReply(r.content);
  console.log(`\nHTTP ok em ${Date.now() - t0} ms | modelo respondido: ${r.model || '?'} | finish_reason: ${r.finish_reason}`);
  console.log(`uso      : ${JSON.stringify(r.usage)}`);
  console.log(`resposta : ${JSON.stringify(r.content).slice(0, 500)}`);
  console.log(`protocolo: ${parsed.kind}${parsed.kind === 'message' ? ` ("${parsed.content.slice(0, 80)}")` : parsed.error ? ` (${parsed.error})` : ''}${parsed.notes.length ? ` | notas: ${parsed.notes.join('; ')}` : ''}`);
  process.exit(0);
} catch (e) {
  console.log(`\nFALHA após ${Date.now() - t0} ms: ${e.message}`);
  if (e.status === 401) console.log('→ chave inválida ou ausente.');
  if (e.status === 404) console.log('→ modelo/endpoint não encontrado: confira OPPER_MODEL e OPPER_BASE_URL.');
  if (e.status === 402 || e.status === 403) console.log('→ sem créditos ou sem acesso ao modelo (o catálogo indica grupo de acesso "abliterated").');
  process.exit(1);
}
