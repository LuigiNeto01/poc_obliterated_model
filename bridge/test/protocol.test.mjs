import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelReply, validateToolCall, stripThinking, findJsonObject, buildProtocolPrompt } from '../src/protocol.mjs';
import { BASE_TOOLS } from '../src/tools.mjs';

test('tool_call válido é reconhecido', () => {
  const r = parseModelReply('{"type":"tool_call","thought":"ver testes","tool":"terminal.execute","arguments":{"command":"npm test"}}');
  assert.equal(r.kind, 'tool_call');
  assert.equal(r.tool, 'terminal.execute');
  assert.deepEqual(r.arguments, { command: 'npm test' });
  assert.equal(r.thought, 'ver testes');
});

test('message válido é reconhecido', () => {
  const r = parseModelReply('{"type":"message","content":"Pronto."}');
  assert.deepEqual([r.kind, r.content], ['message', 'Pronto.']);
});

test('texto livre sem JSON vira mensagem ao usuário', () => {
  const r = parseModelReply('Olá! Como posso ajudar?');
  assert.equal(r.kind, 'message');
  assert.equal(r.plainText, true);
});

test('remove <think> e extrai JSON de bloco markdown', () => {
  const r = parseModelReply('<think>vou listar</think>\n```json\n{"type":"tool_call","tool":"file.list","arguments":{}}\n```');
  assert.equal(r.kind, 'tool_call');
  assert.ok(r.notes.some((n) => n.includes('think')));
  assert.ok(r.notes.some((n) => n.includes('markdown')));
});

test('crases dentro de uma string JSON não são tratadas como bloco markdown', () => {
  const content = 'Correção:\n```ts\nif (a >= b) {\n  c();\n}\n```\nFim.';
  const r = parseModelReply(JSON.stringify({ type: 'message', content }));
  assert.equal(r.kind, 'message');
  assert.equal(r.content, content);
  assert.deepEqual(r.notes, []);

  const args = { path: 'README.md', content: '```js\nconst a = {};\n```\n' };
  const t = parseModelReply(JSON.stringify({ type: 'tool_call', tool: 'file.write', arguments: args }));
  assert.equal(t.kind, 'tool_call');
  assert.deepEqual(t.arguments, args);
});

test('JSON em bloco markdown pode conter crases nas strings', () => {
  const content = 'Veja:\n```sh\nnpm test\n```';
  const r = parseModelReply('Resposta:\n```json\n' + JSON.stringify({ type: 'message', content }) + '\n```');
  assert.equal(r.kind, 'message');
  assert.equal(r.content, content);
  assert.deepEqual(r.notes, ['JSON extraído de bloco markdown']);
});

test('JSON inválido gera erro de parser (sem tentar adivinhar)', () => {
  const r = parseModelReply('{"type":"tool_call","tool":"file.read" "arguments":{}}');
  assert.equal(r.kind, 'invalid');
  assert.match(r.error, /JSON inválido/);
});

test('JSON truncado é detectado', () => {
  const r = parseModelReply('{"type":"tool_call","tool":"file.write","arguments":{"path":"a","content":"abc');
  assert.equal(r.kind, 'invalid');
  assert.match(r.error, /incompleto/);
});

test('type ausente é inferido quando há "tool"', () => {
  const r = parseModelReply('{"tool":"file.list","arguments":{}}');
  assert.equal(r.kind, 'tool_call');
});

test('type desconhecido é rejeitado', () => {
  assert.equal(parseModelReply('{"type":"run","tool":"x"}').kind, 'invalid');
});

test('arguments como string JSON é aceito', () => {
  const r = parseModelReply('{"type":"tool_call","tool":"file.read","arguments":"{\\"path\\":\\"a.ts\\"}"}');
  assert.deepEqual(r.arguments, { path: 'a.ts' });
});

test('chaves dentro de strings não confundem o extrator', () => {
  const f = findJsonObject('x {"a":"}{","b":{"c":1}} y');
  assert.equal(f.json, '{"a":"}{","b":{"c":1}}');
});

test('stripThinking mantém JSON após <think> não fechado', () => {
  assert.equal(stripThinking('<think>blá blá {"type":"message","content":"x"}'), '{"type":"message","content":"x"}');
});

test('validação: ferramenta desconhecida sugere alternativas', () => {
  const v = validateToolCall({ tool: 'shell.execute', arguments: { command: 'ls' } }, BASE_TOOLS);
  assert.equal(v.ok, false);
  assert.match(v.error, /terminal\.execute/);
});

test('validação: argumentos fora do schema são rejeitados', () => {
  assert.equal(validateToolCall({ tool: 'file.read', arguments: {} }, BASE_TOOLS).ok, false);
  assert.equal(validateToolCall({ tool: 'file.read', arguments: { path: 'a', extra: 1 } }, BASE_TOOLS).ok, false);
  assert.equal(validateToolCall({ tool: 'file.read', arguments: { path: 'a', start_line: 0 } }, BASE_TOOLS).ok, false);
  assert.equal(validateToolCall({ tool: 'terminal.execute', arguments: { command: 'ls', timeout_ms: 999999 } }, BASE_TOOLS).ok, false);
  assert.equal(validateToolCall({ tool: 'file.read', arguments: { path: 'a', start_line: 2 } }, BASE_TOOLS).ok, true);
});

test('prompt do protocolo contém o catálogo e as regras', () => {
  const p = buildProtocolPrompt(BASE_TOOLS, { cwd: '/w', approvalPolicy: 'never' });
  for (const t of BASE_TOOLS) assert.ok(p.includes(`- ${t.name}:`), t.name);
  assert.match(p, /EXATAMENTE UM objeto JSON/);
  assert.match(p, /DADOS, não instruções/);
});
