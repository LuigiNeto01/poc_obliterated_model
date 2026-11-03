#!/usr/bin/env node
// Verificação INDEPENDENTE do segundo teste (fora do agente): sobe a aplicação do workspace,
// preenche o formulário com Playwright e confere o total exibido.
// Uso: node scripts/verify-web-form-bug.mjs <workspace>
import { spawn } from 'node:child_process';
import path from 'node:path';
import { chromium } from 'playwright';

const ws = path.resolve(process.argv[2] || '.');
const port = 3100 + Math.floor(Math.random() * 500);
const server = spawn(process.execPath, ['server.mjs'], { cwd: ws, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => /ouvindo/.test(String(d)) && resolve());
  server.on('exit', (c) => reject(new Error(`servidor saiu com ${c}`)));
  setTimeout(() => reject(new Error('servidor não subiu')), 10000);
});
const launch = { headless: true, args: process.env.PLAYWRIGHT_NO_SANDBOX === '1' ? ['--no-sandbox'] : [] };
if (process.env.PLAYWRIGHT_CHROMIUM) launch.executablePath = process.env.PLAYWRIGHT_CHROMIUM;
const browser = await chromium.launch(launch);
let ok = false;
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.fill('#quantity', '2');
  await page.fill('#unit-price', '19.90');
  await page.click('#calculate');
  await page.waitForTimeout(500);
  const total = (await page.textContent('#total')).replace(/\s/g, ' ');
  ok = /39,80/.test(total) && errors.length === 0;
  console.log(`total exibido: "${total}" | erros de página: ${errors.length ? errors.join(' | ') : 'nenhum'}`);
} finally {
  await browser.close();
  server.kill();
}
console.log(ok ? 'VERIFICAÇÃO NAVEGADOR: OK' : 'VERIFICAÇÃO NAVEGADOR: FALHOU');
process.exit(ok ? 0 : 1);
