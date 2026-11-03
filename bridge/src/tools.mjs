// Catálogo de ferramentas exposto ao Qwen e tradução determinística para as ferramentas
// nativas do Codex CLI (exec_command, write_stdin, apply_patch via exec_command e MCP).
import fs from 'node:fs';
import crypto from 'node:crypto';
import { checkPath, checkCommand } from './policy.mjs';

/** Quoting POSIX seguro para argumentos de shell (nada é interpolado). */
export function shq(s) {
  return "'" + String(s).replace(/'/g, `'\\''`) + "'";
}

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const bool = (description) => ({ type: 'boolean', description });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const READ_DEFAULT_LINES = 400;
const READ_MAX_LINES = 2000;

function heredocDelimiter(body) {
  let d;
  do d = 'QWEN_PATCH_' + crypto.randomBytes(4).toString('hex');
  while (body.includes(d));
  return d;
}

function applyPatchCommand(patchBody) {
  const d = heredocDelimiter(patchBody);
  return `apply_patch <<'${d}'\n${patchBody}\n${d}`;
}

function toPatchLines(text, prefix) {
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => prefix + l);
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

function countLineSequence(lines, seq) {
  let n = 0;
  outer: for (let i = 0; i + seq.length <= lines.length; i++) {
    for (let j = 0; j < seq.length; j++) if (lines[i + j] !== seq[j]) continue outer;
    n++;
  }
  return n;
}

/**
 * Constrói um patch no formato apply_patch do Codex para substituir old_text por new_text.
 * Lê o arquivo atual (o bridge roda no mesmo ambiente do workspace) para expandir a
 * substituição a linhas inteiras e adicionar contexto suficiente para torná-la única.
 */
export function buildReplacePatch(relPath, original, oldText, newText, replaceAll = false) {
  const text = original.replace(/\r\n/g, '\n');
  const oldN = oldText.replace(/\r\n/g, '\n');
  const newN = newText.replace(/\r\n/g, '\n');
  const count = countOccurrences(text, oldN);
  if (count === 0) {
    return { error: 'old_text não foi encontrado no arquivo. Leia o arquivo novamente (file.read) e copie o trecho exato, incluindo espaços e indentação.' };
  }
  if (count > 1 && !replaceAll) {
    return { error: `old_text aparece ${count} vezes no arquivo. Inclua mais linhas de contexto para torná-lo único, ou use "replace_all": true.` };
  }
  const updated = replaceAll ? text.split(oldN).join(newN) : text.replace(oldN, () => newN);
  if (updated === text) return { error: 'new_text é idêntico a old_text; nenhuma alteração seria feita.' };

  const oldLines = text.split('\n');
  const newLines = updated.split('\n');
  // Diff mínimo por prefixo/sufixo comuns (suficiente para uma ou mais substituições).
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let endOld = oldLines.length - 1;
  let endNew = newLines.length - 1;
  while (endOld >= start && endNew >= start && oldLines[endOld] === newLines[endNew]) {
    endOld--;
    endNew--;
  }
  const removed = oldLines.slice(start, endOld + 1);
  const added = newLines.slice(start, endNew + 1);

  for (let ctx = 3; ctx <= 12; ctx += 3) {
    const before = oldLines.slice(Math.max(0, start - ctx), start);
    const after = oldLines.slice(endOld + 1, Math.min(oldLines.length, endOld + 1 + ctx));
    // Evita linha vazia final artificial (arquivo terminado em \n) como contexto.
    while (after.length && after[after.length - 1] === '' && endOld + after.length === oldLines.length - 1) after.pop();
    const seq = [...before, ...removed, ...after];
    if (seq.length === 0) break;
    if (countLineSequence(oldLines, seq) === 1) {
      const body = [
        '*** Begin Patch',
        `*** Update File: ${relPath}`,
        '@@',
        ...before.map((l) => ' ' + l),
        ...removed.map((l) => '-' + l),
        ...added.map((l) => '+' + l),
        ...after.map((l) => ' ' + l),
        '*** End Patch',
      ].join('\n');
      return { patch: body, newContent: updated };
    }
  }
  // Não foi possível montar um hunk inequívoco: reescreve o arquivo inteiro.
  return { patch: fullWritePatch(relPath, updated), newContent: updated, fallback: 'full_rewrite' };
}

function fullWritePatch(relPath, content) {
  return ['*** Begin Patch', `*** Add File: ${relPath}`, ...toPatchLines(content, '+'), '*** End Patch'].join('\n');
}

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------

function pathOrError(p, ctx, write = false) {
  const r = checkPath(p, ctx, { write });
  if (!r.ok) return { deny: `Acesso negado ao caminho "${p}": ${r.reason}.` };
  return r;
}

function commandDecision(cmd) {
  return checkCommand(cmd);
}

/** Ferramentas base (sempre disponíveis). */
export const BASE_TOOLS = [
  {
    name: 'file.read',
    description: `Lê um arquivo de texto do workspace com números de linha. Por padrão retorna até ${READ_DEFAULT_LINES} linhas; use start_line/end_line para paginar.`,
    schema: obj(
      {
        path: str('Caminho relativo ao workspace.'),
        start_line: int('Primeira linha (1-based).', { minimum: 1 }),
        end_line: int('Última linha (inclusive).', { minimum: 1 }),
      },
      ['path'],
    ),
    translate(args, ctx) {
      const p = pathOrError(args.path, ctx);
      if (p.deny) return p;
      const s = args.start_line ?? 1;
      let e = args.end_line ?? s + READ_DEFAULT_LINES - 1;
      if (e < s) return { invalid: 'end_line deve ser >= start_line.' };
      if (e - s + 1 > READ_MAX_LINES) e = s + READ_MAX_LINES - 1;
      if (!fs.existsSync(p.abs)) return { invalid: `Arquivo não encontrado: ${args.path}. Use file.list para ver os arquivos.` };
      if (fs.statSync(p.abs).isDirectory()) return { invalid: `${args.path} é um diretório. Use file.list.` };
      const awk = `awk -v s=${s} -v e=${e} 'NR>=s && NR<=e {printf "%6d\\t%s\\n", NR, $0} END {printf "[arquivo: %s | total de linhas: %d]\\n", FILENAME, NR}' ${shq(p.rel)}`;
      return { codex: { name: 'exec_command', arguments: { cmd: awk, yield_time_ms: 10000 } } };
    },
  },
  {
    name: 'file.list',
    description: 'Lista arquivos e diretórios (recursivo, ignora node_modules/.git/dist/build/coverage).',
    schema: obj(
      {
        path: str('Diretório relativo ao workspace. Padrão: ".".'),
        max_depth: int('Profundidade máxima (1-8). Padrão: 3.', { minimum: 1, maximum: 8 }),
      },
      [],
    ),
    translate(args, ctx) {
      const p = pathOrError(args.path ?? '.', ctx);
      if (p.deny) return p;
      const depth = args.max_depth ?? 3;
      const cmd = `find ${shq(p.rel)} -maxdepth ${depth} \\( -name node_modules -o -name .git -o -name dist -o -name build -o -name coverage -o -name .codex-home \\) -prune -o -print | sort | head -n 500`;
      return { codex: { name: 'exec_command', arguments: { cmd, yield_time_ms: 10000 } } };
    },
  },
  {
    name: 'file.search',
    description: 'Busca texto nos arquivos do workspace (grep recursivo). Retorna "arquivo:linha:conteúdo".',
    schema: obj(
      {
        query: str('Texto (ou regex se regex=true) a procurar.', { minLength: 1 }),
        path: str('Diretório ou arquivo onde buscar. Padrão: ".".'),
        regex: bool('Interpreta query como expressão regular estendida (grep -E). Padrão: false.'),
        glob: str('Filtra arquivos pelo nome, ex.: "*.ts".'),
        case_insensitive: bool('Ignora maiúsculas/minúsculas. Padrão: false.'),
      },
      ['query'],
    ),
    translate(args, ctx) {
      const p = pathOrError(args.path ?? '.', ctx);
      if (p.deny) return p;
      const flags = ['-rnI', '--color=never', '--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=.codex-home', '--exclude=.env', '--exclude=.env.*'];
      if (args.glob) flags.push(`--include=${shq(args.glob)}`);
      if (args.case_insensitive) flags.push('-i');
      flags.push(args.regex ? '-E' : '-F');
      const cmd = `grep ${flags.join(' ')} -e ${shq(args.query)} -- ${shq(p.rel)} | head -n 200`;
      return { codex: { name: 'exec_command', arguments: { cmd, yield_time_ms: 15000 } } };
    },
  },
  {
    name: 'file.write',
    description: 'Cria ou sobrescreve um arquivo com o conteúdo completo informado.',
    schema: obj({ path: str('Caminho relativo ao workspace.'), content: str('Conteúdo completo do arquivo.') }, ['path', 'content']),
    translate(args, ctx) {
      const p = pathOrError(args.path, ctx, true);
      if (p.deny) return p;
      if (fs.existsSync(p.abs) && fs.statSync(p.abs).isDirectory()) return { invalid: `${args.path} é um diretório.` };
      if (args.content.length > 400_000) return { invalid: 'Conteúdo muito grande (>400 KB).' };
      const content = args.content === '' ? '\n' : args.content;
      return { codex: { name: 'exec_command', arguments: { cmd: applyPatchCommand(fullWritePatch(p.rel, content)) } } };
    },
  },
  {
    name: 'file.patch',
    description: 'Edita um arquivo existente substituindo um trecho exato (old_text) por outro (new_text). Prefira esta ferramenta para correções pontuais.',
    schema: obj(
      {
        path: str('Caminho relativo ao workspace.'),
        old_text: str('Trecho exato atual (copie do file.read, sem os números de linha).', { minLength: 1 }),
        new_text: str('Trecho que substituirá old_text.'),
        replace_all: bool('Substitui todas as ocorrências. Padrão: false.'),
      },
      ['path', 'old_text', 'new_text'],
    ),
    translate(args, ctx) {
      const p = pathOrError(args.path, ctx, true);
      if (p.deny) return p;
      if (!fs.existsSync(p.abs)) return { invalid: `Arquivo não encontrado: ${args.path}. Para criar um arquivo use file.write.` };
      const original = fs.readFileSync(p.abs, 'utf8');
      const r = buildReplacePatch(p.rel, original, args.old_text, args.new_text, args.replace_all === true);
      if (r.error) return { invalid: r.error };
      return { codex: { name: 'exec_command', arguments: { cmd: applyPatchCommand(r.patch) } }, note: r.fallback };
    },
  },
  {
    name: 'file.delete',
    description: 'Exclui um arquivo do workspace. Operação destrutiva: exige autorização explícita do usuário.',
    schema: obj({ path: str('Caminho relativo ao workspace.') }, ['path']),
    destructive: true,
    translate(args, ctx) {
      const p = pathOrError(args.path, ctx, true);
      if (p.deny) return p;
      if (!fs.existsSync(p.abs)) return { invalid: `Arquivo não encontrado: ${args.path}.` };
      if (fs.statSync(p.abs).isDirectory()) return { invalid: 'file.delete remove apenas arquivos, não diretórios.' };
      return {
        codex: { name: 'exec_command', arguments: { cmd: `rm -- ${shq(p.rel)}` } },
        approval: `Excluir o arquivo ${p.rel}`,
      };
    },
  },
  {
    name: 'terminal.execute',
    description:
      'Executa um comando de shell (bash) no workspace e aguarda até timeout_ms. Retorna código de saída, duração e saída (stdout+stderr). Use para testes, builds, git status/diff etc. Para servidores/processos longos use process.start.',
    schema: obj(
      {
        command: str('Comando de shell.', { minLength: 1 }),
        workdir: str('Diretório de trabalho relativo ao workspace. Padrão: raiz do workspace.'),
        timeout_ms: int('Tempo máximo de espera (1000-120000). Padrão: 60000. Se o processo continuar rodando, ele vira uma sessão (use process.read/process.stop).', {
          minimum: 1000,
          maximum: 120000,
        }),
      },
      ['command'],
    ),
    translate(args, ctx) {
      return translateCommand(args, ctx, { yieldDefault: 60000, tty: false });
    },
  },
  {
    name: 'process.start',
    description: 'Inicia um processo de longa duração (ex.: servidor de desenvolvimento) e retorna após alguns segundos com a saída inicial e um session_id.',
    schema: obj(
      {
        command: str('Comando de shell.', { minLength: 1 }),
        workdir: str('Diretório de trabalho relativo ao workspace.'),
        wait_ms: int('Quanto esperar pela saída inicial (1000-30000). Padrão: 5000.', { minimum: 1000, maximum: 30000 }),
      },
      ['command'],
    ),
    translate(args, ctx) {
      return translateCommand({ command: args.command, workdir: args.workdir, timeout_ms: args.wait_ms ?? 5000 }, ctx, { yieldDefault: 5000, tty: true });
    },
  },
  {
    name: 'process.read',
    description: 'Lê a saída (logs) acumulada de um processo iniciado com process.start ou de um comando que excedeu o timeout.',
    schema: obj({ session_id: int('ID da sessão retornado anteriormente.'), wait_ms: int('Espera por nova saída (5000-60000). Padrão: 5000.', { minimum: 5000, maximum: 60000 }) }, ['session_id']),
    translate(args) {
      return { codex: { name: 'write_stdin', arguments: { session_id: args.session_id, chars: '', yield_time_ms: args.wait_ms ?? 5000 } } };
    },
  },
  {
    name: 'process.stop',
    description: 'Encerra um processo iniciado com process.start (envia Ctrl+C).',
    schema: obj({ session_id: int('ID da sessão.') }, ['session_id']),
    translate(args) {
      return { codex: { name: 'write_stdin', arguments: { session_id: args.session_id, chars: '\u0003', yield_time_ms: 2000 } } };
    },
  },
];

function translateCommand(args, ctx, { yieldDefault, tty }) {
  let workdir;
  if (args.workdir) {
    const p = pathOrError(args.workdir, ctx);
    if (p.deny) return p;
    if (!fs.existsSync(p.abs) || !fs.statSync(p.abs).isDirectory()) return { invalid: `workdir não existe ou não é diretório: ${args.workdir}` };
    workdir = p.abs;
  }
  const decision = commandDecision(args.command);
  if (decision.decision === 'deny') return { deny: `Comando bloqueado pela política do executor: ${decision.reason}.` };
  const codexArgs = { cmd: args.command, yield_time_ms: Math.min(args.timeout_ms ?? yieldDefault, 30000), tty };
  if (workdir) codexArgs.workdir = workdir;
  const out = { codex: { name: 'exec_command', arguments: codexArgs } };
  if (decision.decision === 'approval') out.approval = `Executar "${args.command.slice(0, 200)}" (${decision.reason})`;
  return out;
}

// ---------------------------------------------------------------------------
// Ferramentas de navegador (Playwright MCP, quando o Codex as oferece)
// ---------------------------------------------------------------------------

/** Subconjunto permitido do servidor @playwright/mcp. Ferramentas que executam JS arbitrário ficam de fora. */
export const BROWSER_ALLOWED = {
  'browser.navigate': ['browser_navigate', 'Abre uma URL (use apenas http://localhost ou 127.0.0.1).'],
  'browser.snapshot': ['browser_snapshot', 'Retorna a árvore de acessibilidade da página (elementos com refs para clicar/preencher). Use isto para "ver" a página.'],
  'browser.click': ['browser_click', 'Clica em um elemento (use a ref obtida no snapshot).'],
  'browser.type': ['browser_type', 'Digita texto em um campo (ref do snapshot).'],
  'browser.fill_form': ['browser_fill_form', 'Preenche vários campos de formulário.'],
  'browser.select_option': ['browser_select_option', 'Seleciona opção em um <select>.'],
  'browser.press_key': ['browser_press_key', 'Pressiona uma tecla.'],
  'browser.wait_for': ['browser_wait_for', 'Aguarda um texto aparecer/desaparecer ou um tempo.'],
  'browser.find': ['browser_find', 'Procura texto/regex no snapshot de acessibilidade.'],
  'browser.console_messages': ['browser_console_messages', 'Mensagens/erros do console do navegador.'],
  'browser.network_requests': ['browser_network_requests', 'Lista as requisições de rede desde o carregamento.'],
  'browser.network_request': ['browser_network_request', 'Detalhes (headers/corpo) de uma requisição de rede.'],
  'browser.screenshot': ['browser_take_screenshot', 'Salva um screenshot como evidência (o modelo não interpreta imagens).'],
  'browser.navigate_back': ['browser_navigate_back', 'Volta à página anterior.'],
  'browser.close': ['browser_close', 'Fecha a página.'],
};

/**
 * Cria entradas de catálogo para as ferramentas de navegador oferecidas pelo Codex nesta requisição.
 * @param {Map<string, {namespace?: string, name: string, parameters: object}>} codexTools
 */
export function browserTools(codexTools) {
  const out = [];
  for (const [alias, [mcpName, description]] of Object.entries(BROWSER_ALLOWED)) {
    const def = codexTools.get(mcpName);
    if (!def) continue;
    out.push({
      name: alias,
      description,
      schema: def.parameters || obj({}, []),
      translate(args) {
        if (alias === 'browser.navigate') {
          const url = String(args.url || '');
          if (!/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(url) && !/^about:blank$/.test(url)) {
            return { deny: 'Navegação permitida apenas para aplicações locais (localhost/127.0.0.1).' };
          }
        }
        return { codex: { name: mcpName, namespace: def.namespace, arguments: args } };
      },
    });
  }
  return out;
}

/** Extrai as ferramentas que o Codex ofereceu na requisição (inclui namespaces MCP). */
export function indexCodexTools(tools = []) {
  const map = new Map();
  for (const t of tools) {
    if (t.type === 'function') map.set(t.name, { name: t.name, parameters: t.parameters });
    if (t.type === 'namespace') for (const s of t.tools || []) if (s.type === 'function') map.set(s.name, { name: s.name, namespace: t.name, parameters: s.parameters });
  }
  return map;
}

export function buildCatalog(codexTools) {
  const tools = BASE_TOOLS.filter((t) => {
    if (t.name.startsWith('process.') && !codexTools.has('write_stdin')) return false;
    return true;
  });
  if (!codexTools.has('exec_command')) throw new Error('O Codex não ofereceu a ferramenta exec_command; versão do Codex incompatível com o bridge.');
  return [...tools, ...browserTools(codexTools)];
}

// ---------------------------------------------------------------------------
// Normalização de resultados do Codex
// ---------------------------------------------------------------------------

function outputToText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c?.type === 'input_text' || c?.type === 'output_text' || c?.type === 'text') return c.text;
        if (c?.type === 'input_image') return '[imagem omitida — o modelo é apenas textual]';
        return JSON.stringify(c);
      })
      .join('\n');
  }
  if (output && typeof output === 'object') {
    if (typeof output.content === 'string') return output.content;
    if (Array.isArray(output.content)) return outputToText(output.content);
    return JSON.stringify(output);
  }
  return String(output ?? '');
}

/** Interpreta a saída textual do Codex (exec_command / write_stdin / apply_patch / MCP). */
export function parseCodexOutput(output) {
  const raw = outputToText(output);
  const exits = [...raw.matchAll(/(?:Process exited with code|Exit code:)\s*(-?\d+)/g)];
  const wall = /Wall time:\s*([\d.]+)\s*seconds?/.exec(raw);
  const running = /Process running with session ID\s*(\d+)/.exec(raw);
  let text = raw;
  const idx = raw.lastIndexOf('Output:\n');
  if (idx !== -1) text = raw.slice(idx + 'Output:\n'.length);
  const exit_code = exits.length ? Number(exits[exits.length - 1][1]) : null;
  let status;
  if (running) status = 'running';
  else if (exit_code === null) status = /rejected|declined|denied|aborted|failed|error/i.test(raw.slice(0, 300)) && !/Success\./.test(raw) ? 'error' : 'ok';
  else status = exit_code === 0 ? 'ok' : 'error';
  return { status, exit_code, duration_s: wall ? Number(wall[1]) : null, session_id: running ? Number(running[1]) : null, text, raw };
}

export function truncateMiddle(text, max) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n[... ${text.length - max} caracteres omitidos ...]\n${text.slice(-tail)}`;
}
