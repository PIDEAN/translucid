import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeChat, HttpError, loadOpenRouterFreeModels, streamChat } from '../src/background/providers';
import { PROVIDER_PRESETS } from '../src/shared/presets';
import { costOf, defaultPrice, vendorOf } from '../src/shared/pricing';
import { migrateProviders } from '../src/shared/settings';
import { providerLogo } from '../src/ui/provider-logos';

const provider = { ...PROVIDER_PRESETS.find((p) => p.id === 'openrouter')!, apiKey: 'test-key' };
const messages = [{ role: 'user' as const, content: 'Hello' }];
afterEach(() => vi.unstubAllGlobals());

describe('OpenRouter integration', () => {
  it('adds the preset to existing settings without replacing saved configurations', () => {
    const stored = [{ ...PROVIDER_PRESETS[0]!, apiKey: 'saved-key' }];
    const out = migrateProviders(stored);
    expect(out[0]).toEqual(stored[0]);
    expect(out.find((p) => p.id === 'openrouter')).toMatchObject({ model: 'openrouter/free', concurrency: 1, apiKey: '' });
    expect(migrateProviders(out).filter((p) => p.id === 'openrouter')).toHaveLength(1);
    expect(vendorOf({ baseURL: provider.baseURL })).toBe('openrouter');
  });

  it('prices only the free router and free variants at zero', () => {
    for (const model of ['openrouter/free', 'vendor/model:free']) {
      const spec = defaultPrice({ ...provider, model })!;
      expect(spec).toEqual({ input: 0, cacheHit: 0, output: 0, currency: '$' });
      expect(costOf({ promptTokens: 1000, cacheHitTokens: 100, completionTokens: 500 }, spec)).toBe(0);
    }
    expect(defaultPrice({ ...provider, model: 'vendor/model' })).toBeUndefined();
  });

  it('bundles a transparent official logo without a background shape', () => {
    const svg = providerLogo(provider);
    expect(svg.classList.contains('provider-logo-transparent')).toBe(true);
    expect(svg.querySelector('rect, image, style')).toBeNull();
    expect(svg.querySelector('path')?.getAttribute('fill')).toBe('#7624F4');
  });

  it('streams text while skipping keepalives and retaining final usage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response([
      ': OPENROUTER PROCESSING\n\n',
      'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":20,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":5}}}\n\n',
      'data: [DONE]\n\n',
    ].join('')));
    vi.stubGlobal('fetch', fetchMock);
    const usage = vi.fn();
    const chunks: string[] = [];
    for await (const chunk of streamChat(provider, messages, undefined, usage)) chunks.push(chunk);
    expect(chunks.join('')).toBe('你好');
    expect(usage).toHaveBeenCalledWith({ promptTokens: 20, completionTokens: 3, cacheHitTokens: 5 });
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(request.headers.Authorization).toBe('Bearer test-key');
    expect(JSON.parse(request.body)).toMatchObject({ model: 'openrouter/free', stream: true, stream_options: { include_usage: true }, reasoning: { enabled: false } });
  });

  it('retains authentication status for errors inside a stream', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('data: {"error":{"code":401,"message":"Invalid key"}}\n\n')));
    const consume = async () => { for await (const _ of streamChat(provider, messages)) { /* consume */ } };
    await expect(consume()).rejects.toMatchObject({ status: 401, retryable: false });
  });

  it('rejects non-streaming API errors rather than returning empty text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { code: 429, message: 'Rate limited' } })));
    await expect(completeChat(provider, messages)).rejects.toMatchObject({ status: 429, retryable: true });
  });

  it('fetches only currently free text variants without sending credentials', async () => {
    const model = (id: string, prompt = '0', output = ['text']) => ({ id, pricing: { prompt, completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: output } });
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: [model('b/model:free'), model('a/model:free'), model('b/model:free'), model('paid/model'), model('bad/model:free', '1'), model('image/model:free', '0', ['image'])] }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await loadOpenRouterFreeModels()).toEqual(['openrouter/free', 'a/model:free', 'b/model:free']);
    expect(fetchMock.mock.calls[0]![1].headers).toBeUndefined();
  });

  it('reports model catalog failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    await expect(loadOpenRouterFreeModels()).rejects.toBeInstanceOf(HttpError);
  });
});
