// Política determinística de permissões. O modelo NUNCA valida as próprias permissões:
// toda chamada passa por aqui antes de ser traduzida para o executor (Codex).
//
// Camadas de defesa (da mais interna para a mais externa):
//   1. Esta política (bridge): confina caminhos ao workspace, bloqueia comandos perigosos,
//      exige autorização explícita para operações destrutivas/externas.
//   2. Sandbox do Codex (workspace-write, rede desligada, aprovação do usuário).
//   3. Container Docker com apenas o workspace montado.
// As regras de comando são heurísticas (regex) — servem como defesa em profundidade,
// não como fronteira única de segurança.
import fs from 'node:fs';
import path from 'node:path';

const SENSITIVE_DIRS = new Set(['.git', '.ssh', '.aws', '.gnupg', '.codex', '.codex-home', '.agents', '.docker', '.kube', '.config']);
const SENSITIVE_FILE_RES = [
  /^\.env(\..+)?$/i, // .env, .env.local ... (exceto exemplos, tratados abaixo)
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^\.(npmrc|netrc|pypirc|git-credentials)$/i,
  /^credentials(\.json)?$/i,
];
const SAFE_EXAMPLES = /^\.env\.(example|sample|template)$/i;

function isSensitiveName(name) {
  if (SAFE_EXAMPLES.test(name)) return false;
  return SENSITIVE_FILE_RES.some((re) => re.test(name));
}

function realpathOfNearestExisting(p) {
  let cur = p;
  const rest = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  let real = cur;
  try {
    real = fs.realpathSync(cur);
  } catch {
    /* mantém cur */
  }
  return path.join(real, ...rest);
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Valida um caminho de arquivo pedido pelo modelo.
 * @returns {{ok: true, abs: string, rel: string} | {ok: false, reason: string}}
 */
export function checkPath(p, ctx, { write = false } = {}) {
  if (typeof p !== 'string' || !p.trim()) return { ok: false, reason: 'caminho vazio' };
  if (p.includes('\0')) return { ok: false, reason: 'caminho contém byte nulo' };
  const cwd = ctx.cwd;
  const roots = (ctx.roots && ctx.roots.length ? ctx.roots : [cwd]).map((r) => path.resolve(r));
  const expanded = p.startsWith('~') ? null : p;
  if (expanded === null) return { ok: false, reason: 'caminhos com ~ (home) não são permitidos; use caminhos relativos ao workspace' };
  const abs = path.resolve(cwd, expanded);
  const real = realpathOfNearestExisting(abs);
  const realRoots = roots.map((r) => realpathOfNearestExisting(r));
  const inside = realRoots.some((r) => isInside(real, r)) && roots.some((r) => isInside(abs, r));
  if (!inside) return { ok: false, reason: `caminho fora do workspace autorizado (${roots.join(', ')})` };
  const segments = path.relative(roots.find((r) => isInside(abs, r)) || cwd, abs).split(path.sep);
  for (const seg of segments) {
    if (SENSITIVE_DIRS.has(seg)) return { ok: false, reason: `acesso a diretório sensível bloqueado (${seg})` };
  }
  if (isSensitiveName(path.basename(abs))) return { ok: false, reason: `arquivo sensível bloqueado (${path.basename(abs)})` };
  if (write && segments.includes('node_modules')) return { ok: false, reason: 'escrita em node_modules bloqueada' };
  let rel = path.relative(cwd, abs) || '.';
  if (rel.startsWith('..')) rel = abs;
  return { ok: true, abs, rel };
}

// ---------------------------------------------------------------------------
// Comandos de terminal
// ---------------------------------------------------------------------------

const DENY_RULES = [
  [/(^|[\s;&|(])(sudo|doas|su)(\s|$)/, 'elevação de privilégio (sudo/su)'],
  [/(^|[\s;&|(])(mkfs(\.\w+)?|fdisk|parted|shutdown|reboot|poweroff|halt|init\s+[06])(\s|$)/, 'comando de sistema destrutivo'],
  [/(^|[\s;&|(])dd\s[^;&|]*\bof=/, 'dd com destino (of=)'],
  [/:\(\)\s*\{\s*:\|:&\s*\}/, 'fork bomb'],
  [/\b(curl|wget)\b[^;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, 'download executado diretamente no shell'],
  [/(^|[\s;&|(])rm\s+(-[^\s]*\s+)*(\/|~|\$HOME|\.\.)(\/[^\s]*)?(\s|$)/, 'remoção fora do workspace (/, ~, ..)'],
  [/(^|[\s;&|(])rm\s+(-[^\s]*\s+)*\*(\s|$)/, 'remoção com curinga na raiz do diretório'],
  [/(^|[\s;&|(])(printenv|env)(\s*$|\s*[|;&>])/, 'despejo de variáveis de ambiente (pode vazar segredos)'],
  [/(^|[\s;&|(])(export\s+-p|set)(\s*$|\s*[|;&>])/, 'despejo de variáveis de ambiente (pode vazar segredos)'],
  [/\$\{?[A-Za-z_]*(API_KEY|TOKEN|SECRET|PASSWORD)[A-Za-z_]*\}?/i, 'referência a variável secreta'],
  [/\/proc\/[^\s]*\/environ/, 'leitura do ambiente de processos'],
  [/(^|[\s'"=/])\.env(\.(?!example\b|sample\b|template\b)[\w-]+)?(?=$|[\s'"|;&)<>])/, 'acesso a arquivo .env'],
  [/(^|[\s'"=/~])(\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.codex-home|\.codex)(\/|\s|$)/, 'acesso a diretório de credenciais/configuração'],
  [/\b(id_rsa|id_ed25519|id_ecdsa|\.netrc|\.npmrc|\.git-credentials)\b/, 'acesso a arquivo de credenciais'],
  [/(^|[\s;&|(])(docker|podman|kubectl|nsenter|chroot|mount|umount)(\s|$)/, 'ferramenta de container/sistema'],
  [/\bgit\s+push\b[^;&|]*(\s--force\b|\s-f\b|\s--force-with-lease\b)/, 'git push forçado'],
  [/\bgit\s+config\s+--(global|system)\b/, 'alteração de configuração global do git'],
  [/\b(npm|pnpm|yarn)\s+publish\b/, 'publicação de pacote'],
  [/\bchmod\s+(-[^\s]*R[^\s]*\s+)\S+\s+\/(\s|$)/, 'chmod recursivo na raiz'],
  [/\bchown\s+(-[^\s]*R[^\s]*\s+)\S+\s+\/(\s|$)/, 'chown recursivo na raiz'],
  [/(^|[\s;&|(])(ssh|scp|sftp|telnet|ftp)(\s|$)/, 'acesso remoto (ssh/scp/ftp)'],
  [/(^|[\s;&|(])(crontab|systemctl|service)(\s|$)/, 'alteração de serviços do sistema'],
];

const APPROVAL_RULES = [
  [/(^|[\s;&|(])rm(\s|$)/, 'remoção de arquivos'],
  [/(^|[\s;&|(])(rmdir|shred|truncate)(\s|$)/, 'remoção/truncamento de arquivos'],
  [/\bgit\s+(push|reset\s+--hard|clean|rebase|filter-branch|branch\s+-D|stash\s+drop|checkout\s+--\s|restore\s+\.)/, 'operação git destrutiva ou externa'],
  [/\b(npm|pnpm|yarn|bun)\s+(install|i|add|ci|update|upgrade|remove|uninstall|rm|link|dlx)\b/, 'instalação/alteração de dependências (rede)'],
  [/(^|[\s;&|(])(npx|pnpx|bunx)(\s|$)/, 'download/execução de pacote remoto (npx)'],
  [/\b(pip3?|pipx|uv|poetry|cargo|go|gem|apt|apt-get|brew|choco|winget)\s+(install|add|get|update|upgrade)\b/, 'instalação de software (rede)'],
  [/(^|[\s;&|(])(curl|wget)(\s|$)/, 'ferramenta de rede', { allowIfLocalOnly: true }],
  [/(^|[\s;&|(])(nc|ncat|rsync|socat)(\s|$)/, 'ferramenta de rede'],
  [/(^|[\s;&|(])(kill|pkill|killall)(\s|$)/, 'encerramento de processos'],
  [/https?:\/\/(?!(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?([/\s'"]|$))/, 'acesso a URL externa'],
];

const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?([/?#].*)?$/i;

/** true se o comando cita ao menos uma URL e todas apontam para a máquina local. */
function onlyLocalUrls(cmd) {
  const urls = cmd.match(/https?:\/\/[^\s'"|;&)]+/gi) || [];
  return urls.length > 0 && urls.every((u) => LOCAL_URL.test(u));
}

/**
 * Classifica um comando de terminal.
 * @returns {{decision: 'allow'|'approval'|'deny', reason?: string}}
 */
export function checkCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return { decision: 'deny', reason: 'comando vazio' };
  if (cmd.length > 20_000) return { decision: 'deny', reason: 'comando longo demais (>20000 caracteres)' };
  if (cmd.includes('\0')) return { decision: 'deny', reason: 'comando contém byte nulo' };
  for (const [re, reason] of DENY_RULES) if (re.test(cmd)) return { decision: 'deny', reason };
  for (const [re, reason, opts] of APPROVAL_RULES) {
    if (!re.test(cmd)) continue;
    if (opts?.allowIfLocalOnly && onlyLocalUrls(cmd)) continue;
    return { decision: 'approval', reason };
  }
  return { decision: 'allow' };
}

/** Lê a política de aprovação do Codex a partir das instruções de permissão enviadas por ele. */
export function parseApprovalPolicy(text) {
  const m = /Approval policy is currently ([a-z-]+)/i.exec(text || '');
  return m ? m[1].toLowerCase() : null;
}

/** Aprovação interativa só é possível quando o Codex pode perguntar ao usuário. */
export function canAskUser(approvalPolicy) {
  return approvalPolicy === 'on-request' || approvalPolicy === 'untrusted' || approvalPolicy === 'on-failure';
}
