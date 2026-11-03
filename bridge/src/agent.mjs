// Orquestrador de um passo: recebe o histórico do Codex, consulta o Qwen, interpreta a
// resposta estruturada (com correção de formato limitada), aplica validação e política
// e devolve UMA ação para o Codex executar (ou uma mensagem para o usuário).
import crypto from 'node:crypto';
import { convertInput, encodeCallMeta, parseEnvironment } from './convert.mjs';
import { buildCatalog, indexCodexTools } from './tools.mjs';
import { buildProtocolPrompt, parseModelReply, repairMessage, validateToolCall } from './protocol.mjs';
import { chatCompletion, UpstreamError } from './opper.mjs';

const rid = (p) => `${p}_${crypto.randomBytes(8).toString('hex')}`;

function sameCall(a, b) {
  return a && b && a.tool === b.tool && JSON.stringify(a.arguments) === JSON.stringify(b.arguments);
}

export class Agent {
  /**
   * @param {object} cfg configuração completa (loadConfig)
   * @param {import('./logger.mjs').Logger} logger
   * @param {{complete?: Function}} deps permite injetar um cliente de modelo nos testes
   */
  constructor(cfg, logger, deps = {}) {
    this.cfg = cfg;
    this.logger = logger;
    this.complete = deps.complete || ((messages, opts) => chatCompletion(cfg.opper, messages, opts));
    this.pricing = null;
    this.loggedResults = new Set();
  }

  setPricing(p) {
    this.pricing = p;
  }

  costOf(usage) {
    // Preferência: custo real informado pelo provedor (a Opper devolve usage.cost).
    if (typeof usage?.cost === 'number') return usage.cost;
    const pin = this.cfg.opper.priceInputPerMtok ?? this.pricing?.input;
    const pout = this.cfg.opper.priceOutputPerMtok ?? this.pricing?.output;
    if (!usage || pin == null || pout == null) return null;
    return ((usage.prompt_tokens || 0) * pin + (usage.completion_tokens || 0) * pout) / 1e6;
  }

  /**
   * Processa uma requisição /v1/responses do Codex.
   * @returns {Promise<{items: object[], usage: {input_tokens:number, output_tokens:number}}>} itens de saída Responses
   */
  async step(body, { session = 'sem-sessao', turn = null, signal } = {}) {
    const log = (event, data) => this.logger.log(event, { session, turn, ...data });
    const items = Array.isArray(body.input) ? body.input : [];
    const codexTools = indexCodexTools(body.tools || []);
    const catalog = buildCatalog(codexTools);
    const env = parseEnvironment(items);
    const cwd = env.cwd || process.cwd();
    const roots = env.roots.length ? env.roots : [cwd];
    const approvalPolicy = this.cfg.bridge.approvalOverride || env.approvalPolicy || 'never';
    const conv = convertInput(items, { maxResultChars: this.cfg.bridge.maxResultChars, keepFullResults: this.cfg.bridge.keepFullResults });

    for (const r of conv.toolResults) {
      if (this.loggedResults.has(r.call_id)) continue;
      this.loggedResults.add(r.call_id);
      log('tool_result', { ...r, category: r.status === 'error' ? 'tool' : undefined });
    }
    if (this.loggedResults.size > 50_000) this.loggedResults.clear();

    log('turn_request', { items: items.length, step: conv.stepsThisTurn, max_steps: this.cfg.bridge.maxSteps, cwd, approval_policy: approvalPolicy, tools_offered: catalog.map((t) => t.name) });

    const usage = { input_tokens: 0, output_tokens: 0 };

    if (conv.stepsThisTurn >= this.cfg.bridge.maxSteps) {
      const text = `[qwen-bridge] Limite operacional atingido: ${conv.stepsThisTurn} chamadas de ferramenta neste turno (BRIDGE_MAX_STEPS=${this.cfg.bridge.maxSteps}). Execução interrompida. Envie uma nova mensagem para continuar.`;
      log('protocol_error', { category: 'limit', detail: text });
      return { items: [this.messageItem(text)], usage };
    }

    // Autorização explícita pendente: se o usuário respondeu "autorizo <código>", executa a ação suspensa.
    if (conv.pendingApproval) {
      const pa = conv.pendingApproval;
      if (conv.lastUserText && new RegExp(`\\b(autorizo|approve)\\s+${pa.code}\\b`, 'i').test(conv.lastUserText)) {
        const v = validateToolCall({ tool: pa.tool, arguments: pa.arguments }, catalog);
        const t = v.ok ? v.tool.translate(pa.arguments, { cwd, roots, codexTools }) : { invalid: v.error };
        if (t.codex) {
          log('approval_granted', { tool: pa.tool, arguments: pa.arguments, code: pa.code });
          log('tool_call', { tool: pa.tool, arguments: pa.arguments, codex_tool: t.codex.name, codex_arguments: t.codex.arguments, approved_by_user: true });
          return { items: this.toolCallItems({ tool: pa.tool, arguments: pa.arguments, thought: `autorizado pelo usuário (${pa.code})` }, t.codex), usage };
        }
        log('protocol_error', { category: 'policy', detail: `ação autorizada não pôde ser executada: ${t.invalid || t.deny}` });
      } else {
        log('approval_not_granted', { tool: pa.tool, code: pa.code });
      }
    }

    const system = buildProtocolPrompt(catalog, { cwd, approvalPolicy, extraContext: conv.developerContext });
    let messages;
    if (this.cfg.opper.protocolRole === 'user') {
      messages = [...conv.messages];
      const firstUser = messages.findIndex((m) => m.role === 'user');
      if (firstUser >= 0) messages[firstUser] = { role: 'user', content: `${system}\n\n---\n\n${messages[firstUser].content}` };
      else messages.unshift({ role: 'user', content: system });
    } else {
      messages = [{ role: 'system', content: system }, ...conv.messages];
    }
    if (messages[messages.length - 1]?.role === 'assistant') {
      messages.push({ role: 'user', content: 'Continue.' });
    }

    const maxAttempts = this.cfg.bridge.maxRepairs + 1;
    let lastError = '';
    let lastRaw = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
      log('model_request', {
        attempt,
        model: this.cfg.opper.model,
        message_count: messages.length,
        prompt_chars: promptChars,
        params: { temperature: this.cfg.opper.temperature, max_tokens: this.cfg.opper.maxTokens, ...this.cfg.opper.extraParams },
        messages: this.logger.logPrompts ? messages : undefined,
      });
      let res;
      try {
        res = await this.complete(messages, { signal });
      } catch (e) {
        const status = e instanceof UpstreamError ? e.status : null;
        log('api_error', { category: 'api', status, detail: e.message });
        const hint =
          status === 401 ? ' Verifique OPPER_API_KEY no .env.' : status === 404 ? ' Verifique OPPER_MODEL (ID exato do catálogo) e OPPER_BASE_URL.' : status === 402 || status === 403 ? ' Verifique créditos/permissões da conta (o modelo pode exigir acesso ao grupo "abliterated").' : '';
        return { items: [this.messageItem(`[qwen-bridge] Falha na chamada à API do modelo (categoria: api).${hint}\nDetalhe: ${e.message}`)], usage };
      }
      const u = res.usage || {};
      usage.input_tokens += u.prompt_tokens || 0;
      usage.output_tokens += u.completion_tokens || 0;
      lastRaw = res.content;
      log('model_response', { attempt, latency_ms: res.latency_ms, http_attempts: res.attempts, finish_reason: res.finish_reason, usage: res.usage, cost_usd: this.costOf(res.usage), raw: res.content, reasoning: res.reasoning || undefined });

      const parsed = parseModelReply(res.content);
      if (parsed.notes.length) log('protocol_note', { category: 'parser', detail: parsed.notes.join('; ') });

      if (parsed.kind === 'message') {
        log('final_message', { chars: parsed.content.length, plain_text: !!parsed.plainText });
        return { items: [this.messageItem(parsed.content)], usage };
      }

      let feedback;
      let category;
      if (parsed.kind === 'invalid') {
        category = 'parser';
        lastError = parsed.error + (res.finish_reason === 'length' ? ' (a resposta atingiu o limite de tokens)' : '');
        feedback = repairMessage(lastError);
      } else {
        const v = validateToolCall(parsed, catalog);
        if (!v.ok) {
          category = 'validation';
          lastError = v.error;
          feedback = repairMessage(v.error);
        } else if (conv.recentCalls.length >= 2 && sameCall(parsed, conv.recentCalls.at(-1)) && sameCall(parsed, conv.recentCalls.at(-2))) {
          category = 'loop';
          lastError = `Ação repetida pela terceira vez seguida (${parsed.tool}) com os mesmos argumentos.`;
          feedback = `LOOP_DETECTED: ${lastError} O resultado não vai mudar. Escolha uma ação diferente ou envie um "message" ao usuário.`;
        } else {
          let t;
          try {
            t = v.tool.translate(parsed.arguments, { cwd, roots, codexTools });
          } catch (e) {
            t = { invalid: `Falha ao preparar a ferramenta: ${e.message}` };
          }
          if (t.invalid) {
            category = 'validation';
            lastError = t.invalid;
            feedback = `TOOL_ERROR (${parsed.tool}): ${t.invalid}`;
          } else if (t.deny) {
            category = 'policy';
            lastError = t.deny;
            feedback = `POLICY_DENIED (${parsed.tool}): ${t.deny} Escolha outra ação.`;
          } else if (t.approval) {
            // Ação destrutiva/externa: suspende e pede autorização explícita ao usuário (fim do turno).
            const code = crypto.randomBytes(2).toString('hex').toUpperCase();
            log('approval_requested', { tool: parsed.tool, arguments: parsed.arguments, reason: t.approval, code });
            const text = `⚠️ Autorização necessária (qwen-bridge)\n\nO agente quer executar: ${t.approval}.\nFerramenta: ${parsed.tool}\nArgumentos: ${JSON.stringify(parsed.arguments).slice(0, 500)}\n${parsed.thought ? `Motivo do modelo: ${parsed.thought}\n` : ''}\nPara autorizar UMA vez, responda: autorizo ${code}\nQualquer outra resposta nega a ação.`;
            return { items: [this.metaItem({ pending_approval: { code, tool: parsed.tool, arguments: parsed.arguments, thought: parsed.thought || undefined } }, `aguardando autorização ${code}`), this.messageItem(text)], usage };
          } else {
            const codex = t.codex;
            log('tool_call', { attempt, tool: parsed.tool, arguments: parsed.arguments, thought: parsed.thought, codex_tool: codex.namespace ? `${codex.namespace}.${codex.name}` : codex.name, codex_arguments: codex.arguments, note: t.note });
            return { items: this.toolCallItems(parsed, codex), usage };
          }
        }
      }
      log('protocol_error', { category, attempt, detail: lastError, raw_excerpt: String(res.content).slice(0, 500) });
      messages = [...messages, { role: 'assistant', content: String(res.content).slice(0, 6000) || '(vazio)' }, { role: 'user', content: feedback }];
    }

    const text = `[qwen-bridge] O modelo não produziu uma ação válida após ${maxAttempts} tentativas (limite BRIDGE_MAX_REPAIRS=${this.cfg.bridge.maxRepairs}).\nÚltimo erro: ${lastError}\nÚltima resposta bruta do modelo:\n${String(lastRaw).slice(0, 1500)}`;
    log('protocol_error', { category: 'repair_exhausted', detail: lastError });
    return { items: [this.messageItem(text)], usage };
  }

  messageItem(text) {
    return { type: 'message', role: 'assistant', id: rid('msg'), status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  }

  metaItem(meta, summaryText) {
    return { type: 'reasoning', id: rid('rs'), summary: [{ type: 'summary_text', text: summaryText }], encrypted_content: encodeCallMeta(meta) };
  }

  toolCallItems(call, codex) {
    const call_id = rid('call');
    const preview = JSON.stringify(call.arguments);
    const summary = `${call.thought ? call.thought + '\n' : ''}→ ${call.tool} ${preview.length > 200 ? preview.slice(0, 200) + '…' : preview}`;
    const fc = { type: 'function_call', id: rid('fc'), call_id, name: codex.name, arguments: JSON.stringify(codex.arguments), status: 'completed' };
    if (codex.namespace) fc.namespace = codex.namespace;
    return [
      {
        type: 'reasoning',
        id: rid('rs'),
        summary: [{ type: 'summary_text', text: summary }],
        encrypted_content: encodeCallMeta({ call_id, tool: call.tool, arguments: call.arguments, thought: call.thought || undefined }),
      },
      fc,
    ];
  }
}
