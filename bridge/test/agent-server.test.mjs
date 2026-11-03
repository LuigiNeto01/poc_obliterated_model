import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent.mjs';
import { Logger } from '../src/logger.mjs';
import { createServer } from '../src/server.mjs';
import { decodeCallMeta, convertInput } from '../src/convert.mjs';
import { UpstreamError } from '../src/opper.mjs';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-agent-'));
fs.writeFileSync(path.join(ws, 'a.ts'), 'if (x > 100) {}\n');
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-logs-'));

function cfg(over = {}) {
  return {
    opper: { model: 'heabsy/qwen38-obl', temperature: 0.2, maxTokens: 2048, extraParams: {}, protocolRole: 'system', priceInputPerMtok: 0.17, priceOutputPerMtok: 1.19, apiKey: 'op-test-secret-123456', baseUrl: 'http://x' },
    bridge: { maxSteps: 40, maxRepairs: 3, maxResultChars: 12000, keepFullResults: 10, approvalOverride: '', token: '', ...over },
  };
}

const TOOLS = [
  { type: 'function', name: 'exec_command', parameters: {} },
  { type: 'function', name: 'write_stdin', parameters: {} },
  { type: 'function', name: 'view_image', parameters: {} },
];

function body(extra = [], policy = 'never') {
  return {
    model: 'x',
    tools: TOOLS,
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are a coding agent running in the Codex CLI, ...' }] },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: `<permissions instructions>\nApproval policy is currently ${policy}.\n</permissions instructions>` }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<environment_context>\n  <cwd>${ws}</cwd>\n  <workspace_roots><root>${ws}</root></workspace_roots>\n</environment_context>` }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'conserte os testes' }] },
      ...extra,
    ],
  };
}

function scripted(replies) {
  const calls = [];
  const complete = async (messages) => {
    calls.push(messages);
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (r instanceof Error) throw r;
    return { content: r, usage: { prompt_tokens: 100, completion_tokens: 10 }, finish_reason: 'stop', latency_ms: 1, attempts: 1 };
  };
  return { complete, calls };
}

const logger = new Logger({ dir: logDir, secrets: ['op-test-secret-123456'], console: false });

test('tool_call vira reasoning (metadados) + function_call exec_command', async () => {
  const m = scripted(['{"type":"tool_call","thought":"rodar testes","tool":"terminal.execute","arguments":{"command":"npm test"}}']);
  const agent = new Agent(cfg(), logger, { complete: m.complete });
  const out = await agent.step(body());
  assert.equal(out.items.length, 2);
  const [rs, fc] = out.items;
  assert.equal(rs.type, 'reasoning');
  assert.equal(fc.type, 'function_call');
  assert.equal(fc.name, 'exec_command');
  assert.deepEqual(JSON.parse(fc.arguments), { cmd: 'npm test', yield_time_ms: 30000, tty: false });
  const meta = decodeCallMeta(rs.encrypted_content);
  assert.deepEqual([meta.call_id, meta.tool], [fc.call_id, 'terminal.execute']);
  // o prompt base do Codex é substituído pelo protocolo do bridge
  const sys = m.calls[0][0];
  assert.equal(sys.role, 'system');
  assert.match(sys.content, /PROTOCOLO DE RESPOSTA/);
  assert.ok(!m.calls[0].some((x) => x.content.includes('You are a coding agent running in the Codex CLI')));
  assert.equal(out.usage.input_tokens, 100);
});

test('JSON inválido → correção de formato → sucesso na 2ª tentativa', async () => {
  const m = scripted(['{"type":"tool_call" "tool":"file.list"}', '{"type":"tool_call","tool":"file.list","arguments":{}}']);
  const agent = new Agent(cfg(), logger, { complete: m.complete });
  const out = await agent.step(body());
  assert.equal(out.items[1].type, 'function_call');
  assert.equal(m.calls.length, 2);
  assert.match(m.calls[1].at(-1).content, /^PROTOCOL_ERROR: JSON inválido/);
  assert.equal(out.usage.input_tokens, 200);
});

test('tentativas esgotadas → mensagem explicando a falha de protocolo', async () => {
  const m = scripted(['{"type":"tool_call","tool":"nope","arguments":{}}']);
  const agent = new Agent(cfg({ maxRepairs: 2 }), logger, { complete: m.complete });
  const out = await agent.step(body());
  assert.equal(m.calls.length, 3);
  assert.equal(out.items[0].type, 'message');
  assert.match(out.items[0].content[0].text, /não produziu uma ação válida após 3 tentativas/);
});

test('política: comando negado não chega ao Codex e o modelo recebe POLICY_DENIED', async () => {
  const m = scripted(['{"type":"tool_call","tool":"terminal.execute","arguments":{"command":"cat .env"}}', '{"type":"message","content":"Não posso ler o .env."}']);
  const agent = new Agent(cfg(), logger, { complete: m.complete });
  const out = await agent.step(body());
  assert.match(m.calls[1].at(-1).content, /^POLICY_DENIED/);
  assert.equal(out.items[0].type, 'message');
});

test('aprovação: ação destrutiva é suspensa e só executa com "autorizo <código>" do usuário', async () => {
  const reply = '{"type":"tool_call","thought":"preciso da lib","tool":"terminal.execute","arguments":{"command":"npm install lodash"}}';
  const m1 = scripted([reply]);
  const first = await new Agent(cfg(), logger, { complete: m1.complete }).step(body());
  assert.equal(first.items.length, 2);
  const [meta, msg] = first.items;
  assert.equal(meta.type, 'reasoning');
  assert.equal(msg.type, 'message');
  const code = /autorizo ([0-9A-F]{4})/.exec(msg.content[0].text)[1];
  assert.ok(code);

  // Resposta negativa: nada é executado; o modelo é consultado e vê que a ação aguardava autorização.
  const no = [...first.items, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'não, prefira outra abordagem' }] }];
  const m2 = scripted(['{"type":"message","content":"ok, não vou instalar"}']);
  const out2 = await new Agent(cfg(), logger, { complete: m2.complete }).step(body(no));
  assert.equal(out2.items[0].type, 'message');
  const hist = m2.calls[0].map((x) => x.content).join('\n');
  assert.match(hist, /APPROVAL_REQUIRED/);
  assert.ok(!hist.includes('Autorização necessária (qwen-bridge)'));

  // Código errado também não autoriza.
  const wrong = [...first.items, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'autorizo ZZZZ' }] }];
  const m3 = scripted(['{"type":"message","content":"aguardando"}']);
  await new Agent(cfg(), logger, { complete: m3.complete }).step(body(wrong));
  assert.equal(m3.calls.length, 1);

  // Código correto: a ação suspensa é executada sem consultar o modelo.
  const yes = [...first.items, { type: 'message', role: 'user', content: [{ type: 'input_text', text: `autorizo ${code}` }] }];
  const m4 = scripted(['NÃO DEVERIA SER CHAMADO']);
  const out4 = await new Agent(cfg(), logger, { complete: m4.complete }).step(body(yes));
  assert.equal(m4.calls.length, 0);
  assert.equal(out4.items[1].type, 'function_call');
  assert.equal(JSON.parse(out4.items[1].arguments).cmd, 'npm install lodash');
});

test('aprovação: uma ação negada (deny) nunca pode ser autorizada', async () => {
  const m = scripted(['{"type":"tool_call","tool":"terminal.execute","arguments":{"command":"sudo rm -rf /"}}', '{"type":"message","content":"ok"}']);
  const out = await new Agent(cfg(), logger, { complete: m.complete }).step(body());
  assert.match(m.calls[1].at(-1).content, /^POLICY_DENIED/);
  assert.ok(!JSON.stringify(out.items).includes('autorizo'));
});

test('histórico: function_call + output voltam ao modelo como tool_call original + TOOL_RESULT', async () => {
  const m1 = scripted(['{"type":"tool_call","tool":"file.patch","arguments":{"path":"a.ts","old_text":"x > 100","new_text":"x >= 100"}}']);
  const agent = new Agent(cfg(), logger, { complete: m1.complete });
  const first = await agent.step(body());
  const fc = first.items[1];
  const output = { type: 'function_call_output', call_id: fc.call_id, output: 'Wall time: 0.0000 seconds\nOutput:\nExit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nM a.ts\n' };
  const m2 = scripted(['{"type":"message","content":"feito"}']);
  const agent2 = new Agent(cfg(), logger, { complete: m2.complete });
  await agent2.step(body([...first.items, output]));
  const msgs = m2.calls[0];
  const asst = msgs.find((x) => x.role === 'assistant');
  assert.deepEqual(JSON.parse(asst.content), { type: 'tool_call', tool: 'file.patch', arguments: { path: 'a.ts', old_text: 'x > 100', new_text: 'x >= 100' } });
  assert.match(msgs.at(-1).content, /^TOOL_RESULT ferramenta=file\.patch\nstatus=ok exit_code=0/);
  assert.match(msgs.at(-1).content, /Success\. Updated/);
});

test('detecção de loop: terceira ação idêntica seguida é recusada', async () => {
  const call = { tool: 'file.list', arguments: {} };
  const prior = [];
  for (let i = 0; i < 2; i++) {
    const call_id = `call_${i}`;
    prior.push(
      { type: 'reasoning', id: `rs_${i}`, summary: [], encrypted_content: 'qwen-bridge:v1:' + Buffer.from(JSON.stringify({ call_id, ...call })).toString('base64') },
      { type: 'function_call', call_id, name: 'exec_command', arguments: '{}' },
      { type: 'function_call_output', call_id, output: 'Process exited with code 0\nOutput:\na.ts\n' },
    );
  }
  const m = scripted(['{"type":"tool_call","tool":"file.list","arguments":{}}', '{"type":"message","content":"ok"}']);
  await new Agent(cfg(), logger, { complete: m.complete }).step(body(prior));
  assert.match(m.calls[1].at(-1).content, /^LOOP_DETECTED/);
});

test('limite de passos por turno encerra a execução', async () => {
  const prior = [];
  for (let i = 0; i < 3; i++) prior.push({ type: 'function_call', call_id: `c${i}`, name: 'exec_command', arguments: '{"cmd":"ls"}' }, { type: 'function_call_output', call_id: `c${i}`, output: 'Output:\nx' });
  const m = scripted(['{"type":"message","content":"x"}']);
  const out = await new Agent(cfg({ maxSteps: 3 }), logger, { complete: m.complete }).step(body(prior));
  assert.equal(m.calls.length, 0);
  assert.match(out.items[0].content[0].text, /Limite operacional/);
});

test('erro de API vira mensagem categorizada (sem retry infinito no Codex)', async () => {
  const m = scripted([new UpstreamError('HTTP 401 do provedor: unauthorized', { status: 401 })]);
  const out = await new Agent(cfg(), logger, { complete: m.complete }).step(body());
  assert.match(out.items[0].content[0].text, /categoria: api/);
  assert.match(out.items[0].content[0].text, /OPPER_API_KEY/);
});

test('saídas antigas de ferramenta são resumidas para economizar contexto', () => {
  const items = [];
  for (let i = 0; i < 5; i++) items.push({ type: 'function_call', call_id: `c${i}`, name: 'exec_command', arguments: '{}' }, { type: 'function_call_output', call_id: `c${i}`, output: 'Output:\n' + 'z'.repeat(5000) });
  const conv = convertInput(items, { maxResultChars: 12000, keepFullResults: 2 });
  const results = conv.messages.filter((m) => m.role === 'user');
  assert.ok(results.length >= 1);
  const all = conv.messages.map((m) => m.content).join('\n');
  assert.equal((all.match(/omitidos/g) || []).length, 3);
});

test('logs não contêm a chave da API', async () => {
  const m = scripted(['{"type":"message","content":"a chave é op-test-secret-123456"}']);
  await new Agent(cfg(), logger, { complete: m.complete }).step(body(), { session: 'redact-test' });
  const log = fs.readFileSync(path.join(logDir, 'sessions', 'redact-test.jsonl'), 'utf8');
  assert.ok(!log.includes('op-test-secret-123456'));
  assert.match(log, /\[REDACTED\]/);
});

test('servidor HTTP: SSE no formato da Responses API e autenticação por token', async () => {
  const m = scripted(['{"type":"tool_call","tool":"file.list","arguments":{}}']);
  const c = cfg({ token: 'tok-123456' });
  const agent = new Agent(c, logger, { complete: m.complete });
  const server = createServer(c, logger, agent);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const unauth = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', body: '{}' });
    assert.equal(unauth.status, 401);
    const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok-123456', 'content-type': 'application/json', 'session-id': 's1' },
      body: JSON.stringify(body()),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const text = await res.text();
    const events = text.split('\n\n').filter(Boolean).map((b) => JSON.parse(b.split('\n').find((l) => l.startsWith('data: ')).slice(6)));
    assert.deepEqual(events.map((e) => e.type), ['response.created', 'response.output_item.done', 'response.output_item.done', 'response.completed']);
    assert.equal(events[2].item.type, 'function_call');
    assert.equal(events[3].response.usage.total_tokens, 110);
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.api_key_configured, true);
    assert.ok(!JSON.stringify(health).includes('op-test'));
  } finally {
    server.close();
  }
});
