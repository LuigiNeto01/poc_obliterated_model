// Cliente mínimo para o endpoint compatível com OpenAI Chat Completions (Opper ou outro).
// Usa fetch nativo do Node; respeita HTTPS_PROXY via undici quando a variável existir.

export class UpstreamError extends Error {
  constructor(message, { status = null, retryable = false, body = '' } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.body = body;
  }
}

let httpClient;
/** Usa fetch nativo; se HTTPS_PROXY estiver definido, usa undici + ProxyAgent. */
async function getHttp() {
  if (httpClient) return httpClient;
  httpClient = { fetch: globalThis.fetch, extra: {} };
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxy) {
    try {
      const undici = await import('undici');
      const Agent = undici.EnvHttpProxyAgent || undici.ProxyAgent; // EnvHttpProxyAgent respeita NO_PROXY
      httpClient = { fetch: undici.fetch, extra: { dispatcher: undici.EnvHttpProxyAgent ? new Agent() : new Agent(proxy) } };
    } catch {
      /* undici ausente: segue com fetch nativo */
    }
  }
  return httpClient;
}

/**
 * Faz uma chamada de chat completion (sem streaming).
 * @returns {Promise<{content: string, usage: object|null, finish_reason: string|null, raw: object, latency_ms: number, attempts: number}>}
 */
export async function chatCompletion(cfg, messages, { signal } = {}) {
  if (!cfg.apiKey) throw new UpstreamError('OPPER_API_KEY não configurada. Defina a variável no arquivo .env local.', { retryable: false });
  const url = `${cfg.baseUrl}/chat/completions`;
  const body = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
    max_tokens: cfg.maxTokens,
    stream: false,
    ...cfg.extraParams,
  };
  let lastErr;
  const started = Date.now();
  for (let attempt = 1; attempt <= Math.max(1, cfg.maxRetries + 1); attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), cfg.timeoutMs);
    const onAbort = () => ac.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const http = await getHttp();
      const res = await http.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(body),
        signal: ac.signal,
        ...http.extra,
      });
      const text = await res.text();
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        throw new UpstreamError(`HTTP ${res.status} do provedor: ${text.slice(0, 500)}`, { status: res.status, retryable, body: text.slice(0, 2000) });
      }
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new UpstreamError(`Resposta do provedor não é JSON: ${text.slice(0, 300)}`, { retryable: true });
      }
      const choice = json.choices?.[0];
      if (!choice) throw new UpstreamError(`Resposta sem "choices": ${text.slice(0, 300)}`, { retryable: true });
      const msg = choice.message || {};
      let content = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map((c) => c.text || '').join('') : '';
      return {
        content,
        reasoning: msg.reasoning_content || msg.reasoning || null,
        usage: json.usage || null,
        finish_reason: choice.finish_reason ?? null,
        model: json.model,
        id: json.id,
        raw: json,
        latency_ms: Date.now() - started,
        attempts: attempt,
      };
    } catch (e) {
      lastErr = e instanceof UpstreamError ? e : new UpstreamError(`Falha de rede/timeout: ${e.message}`, { retryable: !signal?.aborted });
      if (!lastErr.retryable || attempt > cfg.maxRetries) break;
      await new Promise((r) => setTimeout(r, Math.min(16000, 1000 * 2 ** (attempt - 1))));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastErr;
}

/** Busca preço do modelo no catálogo público da Opper (não requer chave). */
export async function fetchPricing(catalogUrl, modelId) {
  try {
    const http = await getHttp();
    let offset = 0;
    for (let page = 0; page < 20; page++) {
      const res = await http.fetch(`${catalogUrl}?offset=${offset}&limit=200`, { signal: AbortSignal.timeout(20000), ...http.extra });
      if (!res.ok) return null;
      const j = await res.json();
      const m = (j.models || []).find((x) => x.id === modelId || (x.aliases || []).includes(modelId));
      if (m) {
        return {
          input: m.pricing?.input?.[0] ?? null,
          output: m.pricing?.output?.[0] ?? null,
          unit: m.pricing?.billing_unit,
          context_window: m.context_window,
          max_output_tokens: m.max_output_tokens,
          capabilities: m.capabilities,
          access_group: m.access_group || null,
        };
      }
      if (!j.has_more) return null;
      offset = j.next_offset;
    }
  } catch {
    return null;
  }
  return null;
}
