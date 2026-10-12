import { afterEach, describe, expect, it, vi } from 'vitest';
import { anthropicParams } from '../src/background/anthropic';
import { completeChat, HttpError, streamChat, type Usage } from '../src/background/providers';
import type { ChatMessage } from '../src/prompt/assemble';
import { PROVIDER_PRESETS } from '../src/shared/presets';
import { costOf, defaultPrice, resolvedPrice, vendorOf } from '../src/shared/pricing';
import { migrateProviders } from '../src/shared/settings';
import type { ProviderConfig } from '../src/shared/types';

// Each test uses its own key: the SDK client (cached per key) binds fetch at construction.
let n = 0;
const claude = (patch: Partial<ProviderConfig> = {}): ProviderConfig => ({
  ...PROVIDER_PRESETS.find((p) => p.id === 'anthropic')!,
  apiKey: `test-key-${++n}`,
  ...patch,
});
const msgs: ChatMessage[] = [
  { role: 'system', content: 'SYSTEM RULES' },
  { role: 'user', content: '<1>Hello</1>' },
];

const sse = (events: object[]) =>
  new Response(events.map((e) => `event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

const start = (usage: object) => ({
  type: 'message_start',
  message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, stop_sequence: null, usage },
});
const text = (t: string) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } });
const stop = (stop_reason: string, usage: object, stop_details: object | null = null) => ({
  type: 'message_delta',
  delta: { stop_reason, stop_sequence: null, stop_details },
  usage,
});

afterEach(() => vi.unstubAllGlobals());

describe('Claude request parameters', () => {
  it('fast mode: no sampling params, thinking off at effort medium, cached system prompt', () => {
    const body = anthropicParams(claude({ extraBody: { temperature: 0, top_p: 0.9 } }), msgs, 'fast') as any;
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.output_config).toEqual({ effort: 'medium' });
    expect(body.system).toEqual([{ type: 'text', text: 'SYSTEM RULES', cache_control: { type: 'ephemeral' } }]);
    expect(body.messages).toEqual([{ role: 'user', content: '<1>Hello</1>' }]);
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.max_tokens).toBeGreaterThanOrEqual(4096);
  });

  it('extraBody overrides fast defaults; deep mode keeps adaptive thinking', () => {
    const p = claude({ extraBody: { output_config: { effort: 'low' }, thinking: { type: 'disabled' }, max_tokens: 2048 } });
    const fast = anthropicParams(p, msgs, 'fast') as any;
    expect(fast.output_config).toEqual({ effort: 'low' });
    expect(fast.max_tokens).toBe(2048);
    const deep = anthropicParams(p, msgs, 'deep') as any;
    expect(deep.thinking).toEqual({ type: 'adaptive' });
    expect(deep.output_config).toEqual({ effort: 'medium' });
  });
});

describe('Claude streaming', () => {
  it('yields text deltas, sends Anthropic headers, maps cache usage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sse([
        start({ input_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 1 }),
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        text('<1>你'),
        text('好</1>'),
        { type: 'content_block_stop', index: 0 },
        stop('end_turn', { output_tokens: 12 }),
        { type: 'message_stop' },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);
    let usage: Usage | undefined;
    let out = '';
    for await (const d of streamChat(claude(), msgs, undefined, (u) => (usage = u))) out += d;
    expect(out).toBe('<1>你好</1>');
    expect(usage).toEqual({ promptTokens: 940, cacheHitTokens: 900, cacheWriteTokens: 0, completionTokens: 12 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
    const headers = new Headers(init.headers);
    expect(headers.get('x-api-key')).toMatch(/^test-key-/);
    expect(headers.get('anthropic-dangerous-direct-browser-access')).toBe('true');
    expect(headers.get('authorization')).toBeNull();
    const body = JSON.parse(init.body);
    expect(body.stream).toBe(true);
    expect(body.temperature).toBeUndefined();
  });

  it('turns a refusal into a non-retryable error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse([
      start({ input_tokens: 10, output_tokens: 0 }),
      stop('refusal', { output_tokens: 0 }, { type: 'refusal', category: 'cyber', explanation: null }),
      { type: 'message_stop' },
    ])));
    const run = async () => {
      for await (const _ of streamChat(claude(), msgs)) void _;
    };
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('cyber');
  });

  it('maps HTTP errors to HttpError with retryability', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      { status: 529 },
    )));
    const err = await completeChat(claude(), msgs).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(529);
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('Overloaded');
  });

  it('completeChat reads text blocks by type and skips thinking', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse([
      start({ input_tokens: 30, cache_creation_input_tokens: 600, output_tokens: 1 }),
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '小步快跑' } },
      { type: 'content_block_stop', index: 1 },
      stop('end_turn', { output_tokens: 20 }),
      { type: 'message_stop' },
    ])));
    const res = await completeChat(claude(), msgs, undefined, 'deep');
    expect(res.text).toBe('小步快跑');
    expect(res.usage).toEqual({ promptTokens: 630, cacheHitTokens: 0, cacheWriteTokens: 600, completionTokens: 20 });
  });
});

describe('Claude pricing and presets', () => {
  it('has catalog prices for Haiku 5.5 and bills cache writes at 1.25×', () => {
    const p = claude();
    expect(vendorOf({ baseURL: 'https://api.anthropic.com' })).toBe('anthropic');
    expect(defaultPrice(p)).toMatchObject({ input: 0.1, cacheHit: 0.01, output: 0.5, currency: '$' });
    const spec = resolvedPrice(p);
    // 1M fresh input + 1M cache write + 1M cache read + 1M output
    const cost = costOf({ promptTokens: 3e6, cacheHitTokens: 1e6, cacheWriteTokens: 1e6, completionTokens: 1e6 }, spec);
    expect(cost).toBeCloseTo(0.1 + 0.125 + 0.01 + 0.5, 6);
    // Overriding input keeps the write surcharge proportional.
    const custom = resolvedPrice(claude({ price: { input: 0.2 } }));
    expect(custom.cacheWrite).toBeCloseTo(0.25, 6);
  });

  it('migration appends the Claude preset to older settings', () => {
    const old = PROVIDER_PRESETS.filter((p) => p.id !== 'anthropic');
    expect(migrateProviders(old).some((p) => p.id === 'anthropic' && p.vendor === 'anthropic')).toBe(true);
  });
});
