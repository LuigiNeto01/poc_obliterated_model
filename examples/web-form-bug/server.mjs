// Servidor HTTP mínimo (sem dependências): página estática + API de orçamento.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
};

export function quote({ quantity, unitPrice }) {
  const q = Number(quantity);
  const p = Number(unitPrice);
  if (!Number.isInteger(q) || q <= 0) throw new RangeError('quantidade inválida');
  if (!Number.isFinite(p) || p < 0) throw new RangeError('preço inválido');
  return { quantity: q, unitPrice: p, total: Math.round(q * p * 100) / 100 };
}

export function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      res.writeHead(200, { 'content-type': type });
      res.end(fs.readFileSync(path.join(dir, file)));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/quote') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const result = quote(JSON.parse(body || '{}'));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('não encontrado');
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, '127.0.0.1', () => console.log(`Servidor ouvindo em http://localhost:${PORT}`));
}
