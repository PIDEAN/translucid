import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../src/prompt/assemble';
import type { ToContent } from '../src/shared/messages';
import type { Settings } from '../src/shared/types';

// Fake model: answers each request with a scripted function of the segments.
type Responder = (segments: string[], call: number) => string;
let responder: Responder;
let calls: ChatMessage[][] = [];
/** Provider ids per call, and providers that answer 429 "overloaded". */
let callProviders: string[] = [];
let overloaded = new Set<string>();
/** Providers that accept the request but never send a token until aborted. */
let stalled = new Set<string>();
const cache = new Map<string, string>();

vi.mock('wxt/browser', () => ({ browser: { storage: { local: { get: async () => ({}), set: async () => {} } } } }));
vi.mock('../src/background/usage', () => ({ recordUsage: () => {} }));
vi.mock('../src/background/cache', () => ({
  sha256: async (s: string) => s,
  cacheGetMany: async (keys: string[]) => keys.map((k) => cache.get(k)),
  cachePut: async (k: string, v: string) => void cache.set(k, v),
}));
vi.mock('../src/background/providers', async (orig) => {
  const real = await orig<typeof import('../src/background/providers')>();
  return {
    ...real,
    async *streamChat(p: { id: string }, messages: ChatMessage[], signal?: AbortSignal) {
      callProviders.push(p.id);
      if (overloaded.has(p.id)) throw new real.HttpError(429, 'model overloaded');
      if (stalled.has(p.id)) {
        await new Promise<void>((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      }
      calls.push(messages);
      const user = messages[1]!.content;
      const segs = [...user.matchAll(/^<(\d+)>([\s\S]*?)<\/\1>$/gm)].map((m) => m[2]!);
      const out = responder(segs, calls.length);
      // Stream in small chunks to exercise incremental parsing.
      for (let i = 0; i < out.length; i += 7) yield out.slice(i, i + 7);
    },
  };
});

// Fake machine translation: records requests; mtFail makes it throw.
let mtCalls: string[][] = [];
let mtFail = false;
vi.mock('../src/background/mt', async (orig) => ({
  mtSuitable: (await orig<typeof import('../src/background/mt')>()).mtSuitable,
  async machineTranslate(_p: unknown, texts: string[]) {
    mtCalls.push(texts);
    if (mtFail) throw new Error('blocked');
    return texts.map((t) => `机翻：${t}`);
  },
}));

const { TranslateSession } = await import('../src/background/session');
const { DEFAULT_SETTINGS } = await import('../src/shared/settings');

const settings: Settings = {
  ...DEFAULT_SETTINGS,
  providers: DEFAULT_SETTINGS.providers.map((p) => ({ ...p, apiKey: 'k' })),
};

function run(segments: string[], s: Settings = settings) {
  const msgs: ToContent[] = [];
  const session = new TranslateSession({ postMessage: (m) => msgs.push(m) }, () => s);
  const done = session.handle({
    type: 'translate',
    ctx: { url: 'https://example.org/a', host: 'example.org', title: 'T' },
    segments: segments.map((text, i) => ({ id: i + 1, text })),
  });
  return { msgs, done };
}

// Replace words with 译文 but leave <a1>/{{1}} markup intact, like a well-behaved model.
const zh = (s: string) =>
  '中文：' + s.split(/(<\/?[a-z]\d+>|\{\{\d+\}\})/).map((p, i) => (i % 2 ? p : p.replace(/[A-Za-z]+/g, '译文'))).join('');
const results = (msgs: ToContent[]) =>
  Object.fromEntries(msgs.filter((m) => m.type === 'result').map((m) => [(m as any).id, (m as any).text]));

describe('TranslateSession', () => {
  beforeEach(() => {
    calls = [];
    mtCalls = [];
    mtFail = false;
    callProviders = [];
    overloaded = new Set();
    stalled = new Set();
    cache.clear();
  });

  it('sends plain short strings to free machine translation, markup and long text to the LLM', async () => {
    responder = (segs) => segs.map((s, i) => `<${i + 1}>${zh(s)}</${i + 1}>`).join('');
    const s: Settings = { ...settings, shortTextProviderId: 'google-translate' };
    const { msgs, done } = run(['Settings', 'Pricing', 'Open <a1>Docs</a1>', 'A long paragraph that is clearly body text'], s);
    await done;
    expect(mtCalls).toEqual([['Settings', 'Pricing']]);
    const r = results(msgs);
    expect(r[1]).toBe('机翻：Settings');
    expect(r[3]).toContain('<a1>');
    expect(calls.flatMap((c) => [...c[1]!.content.matchAll(/^<\d+>([\s\S]*?)<\/\d+>$/gm)].map((m) => m[1]))).toEqual([
      'Open <a1>Docs</a1>',
      'A long paragraph that is clearly body text',
    ]);
  });

  it('moves batches to the fallback provider when the main one is overloaded', async () => {
    responder = (segs) => segs.map((s, i) => `<${i + 1}>${zh(s)}</${i + 1}>`).join('');
    overloaded = new Set(['glm-global']);
    const s: Settings = { ...settings, activeProviderId: 'glm-global', fallbackProviderId: 'deepseek' };
    const { msgs, done } = run(['First paragraph with several words', 'Second paragraph with several words'], s);
    await done;
    expect(Object.keys(results(msgs))).toHaveLength(2);
    expect(msgs.some((m) => m.type === 'error')).toBe(false);
    // One retry on the main provider at most, then the fallback.
    expect(callProviders.filter((id) => id === 'glm-global').length).toBeLessThanOrEqual(2);
    expect(callProviders).toContain('deepseek');
  }, 15_000);

  it('overflows a batch with no first token in time to the fallback provider', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      responder = (segs) => segs.map((s, i) => `<${i + 1}>${zh(s)}</${i + 1}>`).join('');
      stalled = new Set(['nvidia']);
      const s: Settings = { ...settings, activeProviderId: 'nvidia', fallbackProviderId: 'deepseek' };
      const { msgs, done } = run(['A paragraph that the slow provider never starts'], s);
      await vi.advanceTimersByTimeAsync(9000);
      await done;
      expect(results(msgs)[1]).toContain('中文');
      expect(callProviders).toEqual(['nvidia', 'deepseek']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the main LLM when machine translation fails, and never makes it the main provider', async () => {
    responder = (segs) => segs.map((s, i) => `<${i + 1}>${zh(s)}</${i + 1}>`).join('');
    mtFail = true;
    const s: Settings = { ...settings, activeProviderId: 'microsoft-translator', shortTextProviderId: 'microsoft-translator' };
    const { msgs, done } = run(['Sign in', 'Body text that should go to the language model'], s);
    await done;
    expect(mtCalls).toHaveLength(1);
    expect(Object.keys(results(msgs))).toHaveLength(2);
    expect(results(msgs)[1]).toContain('中文');
  });

  it('translates in batches, first batch small, then the rest', async () => {
    responder = (segs) => segs.map((s, i) => `<${i + 1}>${zh(s)}</${i + 1}>`).join('\n');
    const segs = Array.from({ length: 12 }, (_, i) => `Paragraph number ${'abcdefghijkl'[i]} with words`);
    const { msgs, done } = run(segs);
    await done;
    expect(Object.keys(results(msgs))).toHaveLength(12);
    expect(calls.length).toBe(2);
    // first batch capped by firstBatchSegments (8)
    expect([...calls[0]![1]!.content.matchAll(/^<\d+>/gm)]).toHaveLength(8);
  });

  it('serves repeats from cache without calling the model', async () => {
    responder = (segs) => segs.map((s, i) => `<${i + 1}>${zh(s)}</${i + 1}>`).join('');
    await run(['Hello there my friend']).done;
    calls = [];
    const { msgs, done } = run(['Hello there my friend']);
    await done;
    expect(calls).toHaveLength(0);
    expect(msgs.find((m) => m.type === 'result')).toMatchObject({ cached: true });
  });

  it('retries only the segments that failed validation', async () => {
    responder = (segs, call) =>
      segs
        .map((s, i) => {
          // first call: segment 2 drops its link tag and segment 3 is missing entirely
          if (call === 1 && i === 1) return `<2>链接丢了</2>`;
          if (call === 1 && i === 2) return '';
          return `<${i + 1}>${zh(s)}</${i + 1}>`;
        })
        .join('');
    const { msgs, done } = run(['First sentence goes here', 'Click <a1>this link</a1> please', 'Third sentence goes here']);
    await done;
    const r = results(msgs);
    expect(Object.keys(r)).toHaveLength(3);
    expect(r[2]).toContain('<a1>');
    expect(calls).toHaveLength(2);
    expect(calls[1]![1]!.content).not.toContain('First sentence');
  });

  it('accepts a dropped link on the second try instead of falling back to plain text', async () => {
    responder = (segs) => segs.map((_, i) => `<${i + 1}>请点击这个链接</${i + 1}>`).join('');
    const { msgs, done } = run(['Click <a1>this link</a1> please']);
    await done;
    expect(calls).toHaveLength(2);
    expect(results(msgs)[1]).toBe('请点击这个链接');
  });

  it('walks the full ladder when code atoms keep disappearing, ending in plain text', async () => {
    responder = (segs) => segs.map((_, i) => `<${i + 1}>现在运行吧朋友们</${i + 1}>`).join('');
    const { msgs, done } = run(['Run {{1}} now please my friends']);
    await done;
    // attempts: batch, half, alone, alone-plain (atoms stripped, so the answer now passes)
    expect(calls).toHaveLength(4);
    expect(calls[3]![1]!.content).toContain('<1>Run now please my friends</1>');
    expect(msgs.filter((m) => m.type !== 'metric').at(-1)).toMatchObject({ type: 'result', id: 1, plain: true });
  });
});
