#!/usr/bin/env node
// qwen-bridge: camada de compatibilidade entre o Codex CLI (Responses API com tool calling
// nativo) e um modelo SEM tool calling nativo (Qwen3.8-27B OBLITERATED via Opper).
//
//   Codex  --POST /v1/responses (SSE)-->  qwen-bridge  --chat/completions-->  Opper/Qwen
//   Codex  <--function_call/message------  qwen-bridge  <--JSON estruturado---  Qwen
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadDotEnv } from './config.mjs';
import { Logger } from './logger.mjs';
import { Agent } from './agent.mjs';
import { fetchPricing } from './opper.mjs';

function sseWriter(res) {
  let seq = 0;
  return (obj) => {
    obj.sequence_number = seq++;
    res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`);
  };
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('corpo da requisição muito grande'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sessionInfo(req) {
  let turn = null;
  try {
    turn = JSON.parse(req.headers['x-codex-turn-metadata'] || '{}').turn_id || null;
  } catch {
    /* cabeçalho opcional */
  }
  return { session: req.headers['session-id'] || req.headers['x-client-request-id'] || 'sem-sessao', turn };
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export function createServer(cfg, logger, agent) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, model: cfg.opper.model, base_url: cfg.opper.baseUrl, api_key_configured: !!cfg.opper.apiKey, pricing: agent.pricing }));
        return;
      }
      if (cfg.bridge.token) {
        const auth = req.headers.authorization || '';
        if (!safeEqual(auth, `Bearer ${cfg.bridge.token}`)) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'token do bridge inválido', type: 'unauthorized' } }));
          return;
        }
      }
      if (req.method === 'GET' && url.pathname.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: cfg.opper.model, object: 'model', owned_by: 'qwen-bridge' }] }));
        return;
      }
      if (req.method !== 'POST' || !url.pathname.endsWith('/responses')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `rota não suportada: ${req.method} ${url.pathname}` } }));
        return;
      }

      const body = JSON.parse(await readBody(req));
      const { session, turn } = sessionInfo(req);
      const responseId = `resp_${crypto.randomBytes(10).toString('hex')}`;
      const ac = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) ac.abort(new Error('cliente desconectou'));
      });

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const send = sseWriter(res);
      const base = { id: responseId, object: 'response', model: cfg.opper.model, created_at: Math.floor(Date.now() / 1000) };
      send({ type: 'response.created', response: { ...base, status: 'in_progress', output: [] } });
      // Mantém o stream "vivo" enquanto o modelo pensa (evento ignorado pelo Codex).
      const heartbeat = setInterval(() => send({ type: 'response.in_progress', response: { ...base, status: 'in_progress' } }), 15000);

      let result;
      try {
        result = await agent.step(body, { session, turn, signal: ac.signal });
      } catch (e) {
        logger.log('bridge_error', { session, turn, category: 'bridge', detail: e.stack || e.message });
        result = { items: [agent.messageItem(`[qwen-bridge] Erro interno do bridge: ${e.message}`)], usage: { input_tokens: 0, output_tokens: 0 } };
      } finally {
        clearInterval(heartbeat);
      }
      if (ac.signal.aborted) return;
      result.items.forEach((item, output_index) => {
        send({ type: 'response.output_item.done', output_index, item });
      });
      const u = result.usage;
      send({
        type: 'response.completed',
        response: {
          ...base,
          status: 'completed',
          output: result.items,
          usage: {
            input_tokens: u.input_tokens,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: u.output_tokens,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: u.input_tokens + u.output_tokens,
          },
        },
      });
      res.end();
    } catch (e) {
      logger.log('bridge_error', { category: 'bridge', detail: e.stack || e.message });
      if (!res.headersSent) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message } }));
      } else res.end();
    }
  });
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  loadDotEnv(process.env.BRIDGE_ENV_FILE || path.join(root, '.env'));
  const cfg = loadConfig();
  const logger = new Logger({ dir: cfg.bridge.logDir, secrets: [cfg.opper.apiKey, cfg.bridge.token], logPrompts: cfg.bridge.logPrompts });
  const agent = new Agent(cfg, logger);
  const server = createServer(cfg, logger, agent);
  server.listen(cfg.bridge.port, cfg.bridge.host, () => {
    logger.log('bridge_start', {
      detail: `ouvindo em http://${cfg.bridge.host}:${cfg.bridge.port}/v1 → ${cfg.opper.baseUrl} modelo=${cfg.opper.model} chave=${cfg.opper.apiKey ? 'configurada' : 'AUSENTE'}`,
      model: cfg.opper.model,
      base_url: cfg.opper.baseUrl,
    });
  });
  if (cfg.opper.priceInputPerMtok == null && /opper\.ai/.test(cfg.opper.baseUrl)) {
    fetchPricing(cfg.opper.catalogUrl, cfg.opper.model).then((p) => {
      agent.setPricing(p);
      logger.log('model_catalog', { detail: p ? `catálogo Opper: entrada $${p.input}/Mtok, saída $${p.output}/Mtok, contexto ${p.context_window}, capacidades ${p.capabilities?.join(',')}` : 'modelo não encontrado no catálogo público (custo não será estimado)', catalog: p });
    });
  }
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[bridge] falha ao iniciar: ${e.message}\n`);
    process.exit(1);
  });
}
