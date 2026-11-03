#!/usr/bin/env node
// Servidor Chat Completions SIMULADO que imita o Qwen com respostas roteirizadas.
// Serve para validar todo o encanamento (Codex → bridge → "modelo" → executor) sem API real.
// NÃO mede a competência do modelo — apenas que o protocolo e as ferramentas funcionam.
//
// Uso: node mock/mock-qwen.mjs <cenario.json> [porta]
// Cada passo do cenário: { "expect": "texto que deve estar na última mensagem do usuário", "reply": "<resposta bruta>" }
import http from 'node:http';
import fs from 'node:fs';

const [scenarioFile, portArg] = process.argv.slice(2);
if (!scenarioFile) {
  console.error('uso: node mock/mock-qwen.mjs <cenario.json> [porta]');
  process.exit(2);
}
const scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
const steps = scenario.steps;
const port = Number(portArg || process.env.MOCK_PORT || 18901);
const transcriptFile = process.env.MOCK_TRANSCRIPT || null;
let index = 0;
const failures = [];

function record(entry) {
  if (transcriptFile) fs.appendFileSync(transcriptFile, JSON.stringify(entry) + '\n');
}

http
  .createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/status') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ index, total: steps.length, failures }));
        return;
      }
      if (!req.url.endsWith('/chat/completions')) {
        res.writeHead(404);
        res.end('{}');
        return;
      }
      if (!/^Bearer .+/.test(req.headers.authorization || '')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"error":"missing key"}');
        return;
      }
      const body = JSON.parse(raw);
      const lastUser = [...body.messages].reverse().find((m) => m.role === 'user')?.content || '';
      let reply;
      const step = steps[index];
      if (!step) {
        reply = JSON.stringify({ type: 'message', content: 'MOCK_SCRIPT_EXHAUSTED' });
        failures.push({ index, error: 'roteiro esgotado' });
      } else if (step.expect && !lastUser.includes(step.expect)) {
        const error = `passo ${index}: esperado "${step.expect}" na última mensagem do usuário`;
        failures.push({ index, error, got: lastUser.slice(0, 2000) });
        reply = JSON.stringify({ type: 'message', content: `MOCK_EXPECTATION_FAILED: ${error}` });
        index = steps.length; // aborta
      } else {
        reply = typeof step.reply === 'string' ? step.reply : JSON.stringify(step.reply);
        index++;
      }
      record({ index, model: body.model, last_user: lastUser.slice(0, 4000), reply });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: `chatcmpl-mock-${index}`,
          object: 'chat.completion',
          model: body.model,
          created: Math.floor(Date.now() / 1000),
          choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
          usage: { prompt_tokens: Math.ceil(JSON.stringify(body.messages).length / 4), completion_tokens: Math.ceil(reply.length / 4), total_tokens: 0 },
        }),
      );
    });
  })
  .listen(port, process.env.MOCK_HOST || '127.0.0.1', () => console.error(`[mock-qwen] ${steps.length} passos em http://${process.env.MOCK_HOST || '127.0.0.1'}:${port}/v1`));
