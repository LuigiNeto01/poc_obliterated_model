// Converte o histórico enviado pelo Codex (Responses API, stateless) em mensagens
// de Chat Completions para o Qwen, usando o protocolo JSON do bridge.
import { parseApprovalPolicy } from './policy.mjs';
import { parseCodexOutput, truncateMiddle } from './tools.mjs';

export const REASONING_PREFIX = 'qwen-bridge:v1:';

export function encodeCallMeta(meta) {
  return REASONING_PREFIX + Buffer.from(JSON.stringify(meta), 'utf8').toString('base64');
}

export function decodeCallMeta(s) {
  if (typeof s !== 'string' || !s.startsWith(REASONING_PREFIX)) return null;
  try {
    return JSON.parse(Buffer.from(s.slice(REASONING_PREFIX.length), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      if (c.type === 'input_text' || c.type === 'output_text' || c.type === 'text') return c.text;
      if (c.type === 'input_image') return '[imagem anexada omitida — o modelo é apenas textual]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

const DROP_DEVELOPER = [
  /^You are a coding agent running in the Codex CLI/, // prompt base para modelos com tool calling nativo
  /^You are Codex/,
  /<skills_instructions>/,
  /<apps_instructions>/,
  /<plugins_instructions>/,
];

/** Extrai cwd / workspace roots do <environment_context>. */
export function parseEnvironment(items) {
  let cwd = null;
  const roots = [];
  let approvalPolicy = null;
  for (const it of items) {
    if (it.type !== 'message') continue;
    const t = contentText(it.content);
    const c = /<cwd>([^<]+)<\/cwd>/.exec(t);
    if (c) cwd = c[1].trim();
    for (const m of t.matchAll(/<root>([^<]+)<\/root>/g)) if (!roots.includes(m[1].trim())) roots.push(m[1].trim());
    const ap = parseApprovalPolicy(t);
    if (ap) approvalPolicy = ap;
  }
  return { cwd, roots, approvalPolicy };
}

/**
 * Converte itens do Codex em mensagens de chat.
 * @returns {{messages: Array<{role:string, content:string}>, developerContext: string, stepsThisTurn: number,
 *           recentCalls: Array<{tool:string, arguments:object}>, toolResults: Array<object>}}
 */
export function convertInput(items, { maxResultChars = 12000, keepFullResults = 10 } = {}) {
  const messages = [];
  const developerParts = [];
  const metaByCall = new Map();
  const callInfo = new Map();
  const toolResults = [];
  let stepsThisTurn = 0;
  const recentCalls = [];

  // Pré-passagem: metadados que o bridge anexou como "reasoning.encrypted_content".
  for (const it of items) {
    if (it.type === 'reasoning') {
      const meta = decodeCallMeta(it.encrypted_content);
      if (meta?.call_id) metaByCall.set(meta.call_id, meta);
    }
  }

  // Índices das saídas de ferramenta, para manter só as N mais recentes completas.
  const outputIdx = items.map((it, i) => (it.type === 'function_call_output' ? i : -1)).filter((i) => i >= 0);
  const fullFrom = outputIdx.length > keepFullResults ? outputIdx[outputIdx.length - keepFullResults] : 0;

  // Autorização pendente: último item de metadados com pending_approval, seguido apenas de
  // mensagens (a do bridge e a resposta do usuário), terminando em mensagem do usuário.
  let pendingApproval = null;
  let lastUserText = '';
  let pendingIdx = -1;
  items.forEach((it, i) => {
    if (it.type === 'reasoning' && decodeCallMeta(it.encrypted_content)?.pending_approval) pendingIdx = i;
  });
  if (pendingIdx >= 0) {
    const after = items.slice(pendingIdx + 1);
    const last = after[after.length - 1];
    if (after.length >= 2 && after.every((x) => x.type === 'message') && last.role === 'user') {
      pendingApproval = decodeCallMeta(items[pendingIdx].encrypted_content).pending_approval;
    }
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.type === 'message' && it.role === 'user') {
      const t = contentText(it.content);
      if (!/^<environment_context>/.test(t.trim())) {
        lastUserText = t;
        break;
      }
    }
  }
  let skipNextAssistant = false;

  const push = (role, content) => {
    const last = messages[messages.length - 1];
    // Mescla mensagens consecutivas do mesmo papel (alguns templates exigem alternância).
    if (last && last.role === role) last.content += '\n\n' + content;
    else messages.push({ role, content });
  };

  items.forEach((it, i) => {
    switch (it.type) {
      case 'message': {
        const text = contentText(it.content);
        if (!text.trim()) return;
        if (it.role === 'developer' || it.role === 'system') {
          if (DROP_DEVELOPER.some((re) => re.test(text.trim()))) return;
          developerParts.push(text.trim());
          return;
        }
        if (it.role === 'user') {
          const isEnv = /^<environment_context>/.test(text.trim());
          if (!isEnv) {
            stepsThisTurn = 0;
            recentCalls.length = 0;
          }
          push('user', isEnv ? `Contexto do ambiente (informativo):\n${text}` : text);
          return;
        }
        if (it.role === 'assistant') {
          if (skipNextAssistant) {
            skipNextAssistant = false; // texto de autorização gerado pelo bridge, já representado acima
            return;
          }
          push('assistant', JSON.stringify({ type: 'message', content: text }));
        }
        return;
      }
      case 'function_call': {
        stepsThisTurn++;
        const meta = metaByCall.get(it.call_id);
        let call;
        if (meta) call = { type: 'tool_call', thought: meta.thought || undefined, tool: meta.tool, arguments: meta.arguments };
        else {
          let args = {};
          try {
            args = JSON.parse(it.arguments || '{}');
          } catch {
            args = { raw: it.arguments };
          }
          call = { type: 'tool_call', tool: `codex.${it.namespace ? it.namespace + '.' : ''}${it.name}`, arguments: args };
        }
        callInfo.set(it.call_id, call.tool);
        recentCalls.push({ tool: call.tool, arguments: call.arguments });
        push('assistant', JSON.stringify(call));
        return;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const tool = callInfo.get(it.call_id) || 'desconhecida';
        const r = parseCodexOutput(it.output);
        const limit = i >= fullFrom ? maxResultChars : 600;
        toolResults.push({ call_id: it.call_id, tool, status: r.status, exit_code: r.exit_code, duration_s: r.duration_s, session_id: r.session_id, output_chars: r.text.length });
        const header = [
          `TOOL_RESULT ferramenta=${tool}`,
          `status=${r.status}${r.exit_code !== null ? ` exit_code=${r.exit_code}` : ''}${r.duration_s !== null ? ` duracao_s=${r.duration_s}` : ''}${r.session_id !== null ? ` session_id=${r.session_id} (processo ainda em execução)` : ''}`,
        ].join('\n');
        const body = truncateMiddle(r.text.trimEnd() || '(sem saída)', limit);
        push('user', `${header}\n--- saída ---\n${body}\n--- fim ---`);
        return;
      }
      case 'reasoning': {
        const meta = decodeCallMeta(it.encrypted_content);
        if (meta?.pending_approval) {
          const pa = meta.pending_approval;
          push('assistant', JSON.stringify({ type: 'tool_call', thought: pa.thought, tool: pa.tool, arguments: pa.arguments }));
          push('user', `APPROVAL_REQUIRED: o executor suspendeu esta ação e pediu autorização explícita ao usuário (código ${pa.code}). Ela só será executada se o usuário responder "autorizo ${pa.code}".`);
          skipNextAssistant = true;
        }
        return;
      }
      default:
        return; // web_search_call etc.: não há equivalente textual necessário
    }
  });

  return { messages, developerContext: developerParts.join('\n\n'), stepsThisTurn, recentCalls, toolResults, pendingApproval, lastUserText };
}
