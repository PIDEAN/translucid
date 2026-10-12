import Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage } from '../prompt/assemble';
import type { ProviderConfig } from '../shared/types';
import { HttpError, parseRetryAfter, type ChatMode, type Usage } from './providers';

// Claude Messages API via the official SDK. Request parameters are tuned for
// Claude Haiku 5.5 as a translation engine:
// - No temperature/top_p/top_k: Haiku 5.5 rejects non-default sampling values.
// - 'fast' (page batches, preprocess): thinking disabled at effort 'medium'. Batches
//   are independent segments under a strict output protocol; thinking would only
//   delay the first segment and bill extra output tokens. In a 2026-10-11 sweep
//   (pnpm try --sweep) medium matched low on tokens and latency but kept Chinese
//   punctuation cleaner. Disabled is accepted at effort low/medium/high only.
// - 'deep' (manual refine): adaptive thinking at effort 'medium', where reasoning
//   about nuance is the point and latency matters less.
// - The fixed system prompt carries cache_control so every batch after the first
//   reads it from cache (minimum cacheable prefix on Haiku 5.5 is 512 tokens).
// extraBody overrides the fast defaults (e.g. {"output_config":{"effort":"low"}}).

const MODE_DEFAULTS: Record<ChatMode, Record<string, unknown>> = {
  fast: { max_tokens: 8192, thinking: { type: 'disabled' }, output_config: { effort: 'medium' } },
  deep: { max_tokens: 16000, thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } },
};

const clients = new Map<string, Anthropic>();

function client(p: ProviderConfig): Anthropic {
  // The SDK appends /v1/messages itself.
  const baseURL = p.baseURL.replace(/\/+$/, '').replace(/\/v1(\/messages)?$/, '');
  const key = `${baseURL}\n${p.apiKey}`;
  let c = clients.get(key);
  if (!c) {
    // Runs in the extension service worker; the key comes from extension storage
    // and never reaches page scripts. Retries are owned by the session ladder.
    c = new Anthropic({ apiKey: p.apiKey, baseURL, dangerouslyAllowBrowser: true, maxRetries: 0, timeout: 90_000 });
    clients.set(key, c);
  }
  return c;
}

/** Request body for the Messages API; exported for tests. */
export function anthropicParams(p: ProviderConfig, messages: ChatMessage[], mode: ChatMode): Anthropic.MessageCreateParamsNonStreaming {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const turns = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  const extra: Record<string, unknown> = { ...p.extraBody };
  // Sampling parameters return a 400 on Claude Haiku 5.5 and newer models.
  delete extra.temperature;
  delete extra.top_p;
  delete extra.top_k;
  if (mode === 'deep') {
    delete extra.thinking;
    delete extra.output_config;
  }
  return {
    ...MODE_DEFAULTS[mode],
    ...extra,
    model: p.model,
    ...(system ? { system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] } : {}),
    messages: turns,
  } as Anthropic.MessageCreateParamsNonStreaming;
}

function toUsage(u: {
  input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  output_tokens?: number | null;
}): Usage {
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  // input_tokens excludes cached and cache-written tokens; promptTokens is the total.
  return { promptTokens: (u.input_tokens ?? 0) + read + write, cacheHitTokens: read, cacheWriteTokens: write, completionTokens: u.output_tokens ?? 0 };
}

function toHttpError(p: ProviderConfig, e: unknown): unknown {
  if (e instanceof Anthropic.APIUserAbortError) return e;
  if (e instanceof Anthropic.APIConnectionError) return new HttpError(503, `${p.name} 网络错误：${e.message}`);
  if (e instanceof Anthropic.APIError && typeof e.status === 'number') {
    const body = (e.error as any)?.error;
    const msg = body?.message ?? e.message;
    // Monthly spend cap: a 429 that no amount of waiting fixes.
    if (body?.details?.error_code === 'enforced_spend_limit_reached') return new HttpError(402, `${p.name} 已达到月度支出上限：${msg}`);
    return new HttpError(e.status, `${p.name} HTTP ${e.status}: ${String(msg).slice(0, 300)}`, parseRetryAfter(e.headers?.get('retry-after')));
  }
  return e;
}

function refusal(p: ProviderConfig, category: string | null | undefined): HttpError {
  // Not retryable: the same input is declined again; the session falls back to smaller batches.
  return new HttpError(400, `${p.name} 拒绝了该请求（安全分类：${category ?? '未知'}）`);
}

function check(p: ProviderConfig) {
  if (!p.apiKey) throw new HttpError(401, `${p.name} 未配置 API Key`);
  if (!p.model) throw new HttpError(400, `${p.name} 未配置模型`);
}

export async function* streamAnthropic(
  p: ProviderConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
  onUsage?: (u: Usage) => void,
  mode: ChatMode = 'fast',
): AsyncGenerator<string> {
  check(p);
  const raw: Parameters<typeof toUsage>[0] = {};
  let seen = false;
  try {
    const stream = client(p).messages.stream(anthropicParams(p, messages, mode), { signal });
    for await (const ev of stream) {
      if (ev.type === 'message_start') {
        Object.assign(raw, ev.message.usage);
        seen = true;
      } else if (ev.type === 'message_delta') {
        // Delta usage is cumulative; null fields mean "unchanged".
        for (const [k, v] of Object.entries(ev.usage)) if (typeof v === 'number') (raw as any)[k] = v;
        if (ev.delta.stop_reason === 'refusal') throw refusal(p, ev.delta.stop_details?.category);
      } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
        // Thinking blocks (if enabled via extraBody) are skipped; only answer text is yielded.
        yield ev.delta.text;
      }
    }
  } catch (e) {
    throw toHttpError(p, e);
  } finally {
    if (seen) onUsage?.(toUsage(raw));
  }
}

export async function completeAnthropic(
  p: ProviderConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
  mode: ChatMode = 'fast',
): Promise<{ text: string; usage?: Usage }> {
  check(p);
  let msg: Anthropic.Message;
  try {
    msg = await client(p).messages.stream(anthropicParams(p, messages, mode), { signal }).finalMessage();
  } catch (e) {
    throw toHttpError(p, e);
  }
  if (msg.stop_reason === 'refusal') throw refusal(p, msg.stop_details?.category);
  // A response can begin with thinking blocks; read text blocks by type.
  const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  return { text: text.trim(), usage: toUsage(msg.usage) };
}
