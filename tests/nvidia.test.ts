import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeChat, streamChat } from '../src/background/providers';
import { PROVIDER_PRESETS } from '../src/shared/presets';
import { costOf, defaultPrice, vendorOf } from '../src/shared/pricing';
import { migrateProviders } from '../src/shared/settings';
import { providerLogo } from '../src/ui/provider-logos';

const provider = { ...PROVIDER_PRESETS.find((p) => p.id === 'nvidia')!, apiKey: 'test-key' };
afterEach(() => vi.unstubAllGlobals());

describe('NVIDIA hosted trial', () => {
  it('adds NVIDIA while preserving keys, models and custom settings', () => {
    const stored = [{ ...PROVIDER_PRESETS[0]!, apiKey: 'saved-key', concurrency: 2 }];
    const out = migrateProviders(stored);
    expect(out[0]).toEqual(stored[0]);
    expect(out.find((p) => p.id === 'nvidia')).toMatchObject({ apiKey: '', model: 'nvidia/nemotron-3-super-120b-a12b', concurrency: 4, rpm: 35 });
    expect(migrateProviders(out).filter((p) => p.id === 'nvidia')).toHaveLength(1);
    expect(vendorOf({ baseURL: 'https://integrate.api.nvidia.com/v1' })).toBe('nvidia');
  });

  it('estimates zero trial cost for the verified hosted model', () => {
    const price = defaultPrice(provider)!;
    expect(price).toEqual({ input: 0, cacheHit: 0, output: 0, currency: '$' });
    expect(costOf({ promptTokens: 1200, cacheHitTokens: 100, completionTokens: 500 }, price)).toBe(0);
    expect(defaultPrice({ ...provider, model: 'unknown/model' })).toBeUndefined();
  });

  it('bundles the official green mark without a background', () => {
    const svg = providerLogo(provider);
    expect(svg.getAttribute('aria-label')).toBe('NVIDIA NIM');
    expect(svg.classList.contains('provider-logo-transparent')).toBe(true);
    expect(svg.querySelector('rect, image, text, style')).toBeNull();
    expect(svg.querySelector('path')?.getAttribute('fill')).toBe('#76B900');
  });

  it('uses the hosted endpoint and non-reasoning settings without stream_options', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"译文"}}]}\n\ndata: [DONE]\n\n'));
    vi.stubGlobal('fetch', fetchMock);
    const usage = vi.fn();
    const chunks: string[] = [];
    for await (const chunk of streamChat(provider, [{ role: 'system', content: 'Translate into Simplified Chinese and preserve <1> tags.' }, { role: 'user', content: '<1>Hello</1>' }], undefined, usage)) chunks.push(chunk);
    expect(chunks.join('')).toBe('译文');
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(request.headers.Authorization).toBe('Bearer test-key');
    const body = JSON.parse(request.body);
    expect(body).toMatchObject({ model: provider.model, stream: true, max_tokens: 4096, temperature: 1, top_p: 0.95, chat_template_kwargs: { enable_thinking: false } });
    expect(body.stream_options).toBeUndefined();
    expect(body.messages[0].content).toContain('preserve <1> tags');
    expect(usage).not.toHaveBeenCalled();
  });

  it('parses non-streaming content and usage for connection tests and preprocessing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ choices: [{ message: { content: '你好' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } })));
    expect(await completeChat(provider, [{ role: 'user', content: 'Hello' }])).toEqual({ text: '你好', usage: { promptTokens: 10, cacheHitTokens: 0, completionTokens: 2 } });
  });
});
