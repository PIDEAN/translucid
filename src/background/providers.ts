import type { ChatMessage } from '../prompt/assemble';
import { vendorOf } from '../shared/pricing';
import type { ProviderConfig } from '../shared/types';
import { completeAnthropic, streamAnthropic } from './anthropic';

export interface Usage {
  promptTokens: number;
  cacheHitTokens: number;
  completionTokens: number;
  /** Tokens written to the prompt cache (Anthropic only; included in promptTokens). */
  cacheWriteTokens?: number;
}

/** 'fast' for page batches and preprocess; 'deep' lets reasoning models think (manual refine). */
export type ChatMode = 'fast' | 'deep';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Server-requested wait from a Retry-After header. */
    public retryAfterMs?: number,
  ) {
    super(message);
  }
  /** 429 / 5xx / overloaded are worth retrying with backoff; auth or bad requests are not. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
  /** Rate limited or overloaded: the provider should slow down, not just this request. */
  get throttled(): boolean {
    return this.status === 429 || this.status === 503 || this.status === 529;
  }
}

/** Retry-After as seconds or an HTTP date; capped so a bad header cannot stall a page. */
export function parseRetryAfter(v: string | null | undefined): number | undefined {
  if (!v) return undefined;
  const secs = Number(v);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(v) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 60_000) : undefined;
}

function endpoint(p: ProviderConfig): string {
  return p.baseURL.replace(/\/+$/, '').replace(/\/chat\/completions$/, '') + '/chat/completions';
}

function body(p: ProviderConfig, messages: ChatMessage[], stream: boolean): string {
  return JSON.stringify({
    model: p.model,
    messages,
    temperature: 0,
    stream,
    ...(stream && p.includeUsage ? { stream_options: { include_usage: true } } : {}),
    ...p.extraBody,
  });
}

function parseUsage(u: any): Usage | undefined {
  if (!u) return undefined;
  return {
    promptTokens: u.prompt_tokens ?? 0,
    // DeepSeek reports prompt_cache_hit_tokens, OpenAI/Gemini prompt_tokens_details.cached_tokens.
    cacheHitTokens: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
    completionTokens: u.completion_tokens ?? 0,
  };
}

async function post(p: ProviderConfig, messages: ChatMessage[], stream: boolean, signal?: AbortSignal) {
  if (!p.apiKey) throw new HttpError(401, `${p.name} 未配置 API Key`);
  if (!p.model) throw new HttpError(400, `${p.name} 未配置模型`);
  const res = await fetch(endpoint(p), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
    body: body(p, messages, stream),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(res.status, `${p.name} HTTP ${res.status}: ${text.slice(0, 300)}`, parseRetryAfter(res.headers.get('retry-after')));
  }
  return res;
}

/** Streams content deltas; onUsage fires once the stream ends if the provider reported usage. */
export async function* streamChat(
  p: ProviderConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
  onUsage?: (u: Usage) => void,
  mode: ChatMode = 'fast',
): AsyncGenerator<string> {
  if (vendorOf(p) === 'anthropic') {
    yield* streamAnthropic(p, messages, signal, onUsage, mode);
    return;
  }
  const res = await post(p, messages, true, signal);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  let usage: Usage | undefined;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (json.error) throw responseError(p, json.error);
        usage = parseUsage(json.usage) ?? usage;
        const delta: string | undefined = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      }
    }
  } finally {
    reader.releaseLock();
    if (usage) onUsage?.(usage);
  }
}

export async function completeChat(
  p: ProviderConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
  mode: ChatMode = 'fast',
): Promise<{ text: string; usage?: Usage }> {
  if (vendorOf(p) === 'anthropic') return completeAnthropic(p, messages, signal, mode);
  const res = await post(p, messages, false, signal);
  const json = await res.json();
  if (json.error) throw responseError(p, json.error);
  const text: string = json.choices?.[0]?.message?.content ?? '';
  return { text: text.replace(/<think>[\s\S]*?<\/think>/g, '').trim(), usage: parseUsage(json.usage) };
}

/** OpenRouter may report an API error inside an otherwise successful HTTP response. */
function responseError(p: ProviderConfig, error: { code?: unknown; message?: string }): HttpError {
  const code = Number(error.code);
  return new HttpError(Number.isInteger(code) && code >= 400 && code <= 599 ? code : 500,
    `${p.name}: ${error.message ?? JSON.stringify(error)}`);
}

/** Public catalog: no API key is needed, and credentials never leave via this request. */
export async function loadOpenRouterFreeModels(): Promise<string[]> {
  const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new HttpError(res.status, `OpenRouter 模型列表 HTTP ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json.data)) throw new Error('OpenRouter 模型列表格式有误');
  const models = json.data.filter((m: any) =>
    typeof m.id === 'string' && m.id.endsWith(':free') &&
    m.pricing?.prompt != null && Number(m.pricing.prompt) === 0 &&
    m.pricing?.completion != null && Number(m.pricing.completion) === 0 &&
    m.architecture?.input_modalities?.includes('text') &&
    m.architecture?.output_modalities?.includes('text'),
  ).map((m: any) => m.id as string);
  return ['openrouter/free', ...[...new Set<string>(models)].sort()];
}

/**
 * DeepSeek serves CN (CNY) and global (USD) accounts on the same endpoint; the
 * balance API tells which one this key belongs to. Returns undefined on any failure.
 */
export async function detectDeepSeekRegion(p: ProviderConfig, signal?: AbortSignal): Promise<'cn' | 'global' | undefined> {
  if (!p.apiKey) return undefined;
  try {
    const origin = new URL(p.baseURL).origin;
    const res = await fetch(`${origin}/user/balance`, { headers: { Authorization: `Bearer ${p.apiKey}` }, signal });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { balance_infos?: { currency?: string }[] };
    const currency = json.balance_infos?.[0]?.currency?.toUpperCase();
    return currency === 'CNY' ? 'cn' : currency === 'USD' ? 'global' : undefined;
  } catch {
    return undefined;
  }
}
