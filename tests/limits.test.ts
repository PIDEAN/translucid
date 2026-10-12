import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderGate } from '../src/background/batching';
import { machineTranslate } from '../src/background/mt';
import { HttpError, parseRetryAfter } from '../src/background/providers';
import { laneBatchChars } from '../src/background/session';
import { PROVIDER_PRESETS } from '../src/shared/presets';
import { isMachineTranslation, providerReady } from '../src/shared/pricing';
import { normalizeSettings } from '../src/shared/settings';
import type { ProviderConfig } from '../src/shared/types';

const preset = (id: string): ProviderConfig => ({ ...PROVIDER_PRESETS.find((p) => p.id === id)! });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ProviderGate', () => {
  it('caps concurrency', async () => {
    const g = new ProviderGate(2);
    let active = 0;
    let peak = 0;
    const task = () => g.run(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(peak).toBe(2);
  });

  it('enforces requests per minute', async () => {
    vi.useFakeTimers();
    const g = new ProviderGate(10, 2);
    const started: number[] = [];
    const all = Promise.all([0, 1, 2].map(() => g.run(async () => void started.push(Date.now()))));
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    await all;
    expect(started).toHaveLength(3);
    expect(started[2]! - started[0]!).toBeGreaterThanOrEqual(60_000);
  });

  it('backs off after a 429: pauses, halves concurrency, restores after a minute', async () => {
    let now = 0;
    const g = new ProviderGate(8, 0, () => now);
    g.backoff(3000);
    expect(g.limit).toBe(4);
    g.backoff();
    expect(g.limit).toBe(2);
    now = 61_000;
    expect(g.limit).toBe(8);
  });
});

describe('rate-limit plumbing', () => {
  it('parses Retry-After seconds and dates, capped at a minute', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter('600')).toBe(60_000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThan(3000);
  });

  it('marks 429/503/529 as throttling', () => {
    expect(new HttpError(429, '').throttled).toBe(true);
    expect(new HttpError(529, '').throttled).toBe(true);
    expect(new HttpError(500, '').throttled).toBe(false);
    expect(new HttpError(402, '').retryable).toBe(false);
  });

  it('spreads a wave over the lanes but keeps big batches for RPM-limited tiers', () => {
    expect(laneBatchChars(12_000, 12, 2000)).toBe(1000);
    expect(laneBatchChars(2_000, 12, 2000)).toBe(500);
    expect(laneBatchChars(60_000, 12, 2000)).toBe(2000);
    expect(laneBatchChars(12_000, 3, 2000, 15)).toBe(2000);
  });

  it('upgrades untouched preset concurrency once and adds RPM caps', () => {
    const stored = PROVIDER_PRESETS.map((p) => {
      const { rpm: _, ...rest } = p;
      return { ...rest, concurrency: ({ deepseek: 6, gemini: 4, anthropic: 3 } as Record<string, number>)[p.id] ?? p.concurrency };
    });
    const s = normalizeSettings({ providers: stored });
    const get = (id: string) => s.providers.find((p) => p.id === id)!;
    expect(get('deepseek').concurrency).toBe(12);
    expect(get('gemini')).toMatchObject({ concurrency: 3, rpm: 15 });
    expect(get('anthropic').concurrency).toBe(3); // user-chosen value is kept
    expect(s.providerDefaultsRev).toBe(2);
    // Already upgraded: a deliberate 6 stays 6.
    const again = normalizeSettings({ ...s, providers: s.providers.map((p) => (p.id === 'deepseek' ? { ...p, concurrency: 6 } : p)) });
    expect(again.providers.find((p) => p.id === 'deepseek')!.concurrency).toBe(6);
  });

  it('applies later revisions only: NVIDIA 2 → 4 for settings at rev 1', () => {
    const providers = PROVIDER_PRESETS.map((p) => (p.id === 'nvidia' ? { ...p, concurrency: 2 } : p.id === 'deepseek' ? { ...p, concurrency: 6 } : p));
    const s = normalizeSettings({ providers, providerDefaultsRev: 1 });
    expect(s.providers.find((p) => p.id === 'nvidia')!.concurrency).toBe(4);
    // rev 1 already ran, so a 6 chosen afterwards is the user's choice.
    expect(s.providers.find((p) => p.id === 'deepseek')!.concurrency).toBe(6);
  });
});

describe('free machine translation', () => {
  it('needs no key and is recognised from the preset', () => {
    for (const id of ['google-translate', 'microsoft-translator']) {
      expect(isMachineTranslation(preset(id))).toBe(true);
      expect(providerReady(preset(id))).toBe(true);
    }
    expect(providerReady(preset('deepseek'))).toBe(false);
  });

  it('Google: batches lines in one POST and splits them back', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json([[['设置\n', 'Settings\n'], ['显示更多\n', 'Show more\n'], ['联系我们', 'Contact us']]]));
    vi.stubGlobal('fetch', fetchMock);
    expect(await machineTranslate(preset('google-translate'), ['Settings', 'Show  more', 'Contact us'])).toEqual(['设置', '显示更多', '联系我们']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('translate.googleapis.com/translate_a/single?client=gtx');
    expect(new URLSearchParams(String(init.body)).get('q')).toBe('Settings\nShow more\nContact us');
  });

  it('Google: falls back to one request per string when lines do not line up', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json([[['设置 显示更多', 'Settings\nShow more']]]))
      .mockResolvedValueOnce(Response.json([[['设置', 'Settings']]]))
      .mockResolvedValueOnce(Response.json([[['显示更多', 'Show more']]]));
    vi.stubGlobal('fetch', fetchMock);
    expect(await machineTranslate(preset('google-translate'), ['Settings', 'Show more'])).toEqual(['设置', '显示更多']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('Microsoft: sends a JSON array and maps translations in order', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json([
      { translations: [{ text: '登录', to: 'zh-Hans' }] },
      { translations: [{ text: '定价', to: 'zh-Hans' }] },
    ]));
    vi.stubGlobal('fetch', fetchMock);
    expect(await machineTranslate(preset('microsoft-translator'), ['Sign in', 'Pricing'])).toEqual(['登录', '定价']);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('edge.microsoft.com/translate/translatetext');
    expect(JSON.parse(init.body)).toEqual(['Sign in', 'Pricing']);
  });

  it('surfaces 429 with Retry-After', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('busy', { status: 429, headers: { 'retry-after': '7' } })));
    const err = await machineTranslate(preset('microsoft-translator'), ['Sign in']).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.retryAfterMs).toBe(7000);
  });
});

describe('ProviderGate lanes', () => {
  it('reports idle lanes, counting running and queued work', async () => {
    const g = new ProviderGate(3);
    expect(g.freeLanes).toBe(3);
    let release!: () => void;
    const block = new Promise<void>((r) => (release = r));
    const runs = [g.run(() => block), g.run(() => block)];
    await Promise.resolve();
    expect(g.freeLanes).toBe(1);
    const more = [g.run(() => block), g.run(() => block)];
    await Promise.resolve();
    expect(g.freeLanes).toBe(0);
    release();
    await Promise.all([...runs, ...more]);
    expect(g.freeLanes).toBe(3);
  });
});

describe('machine translation suitability', () => {
  it('keeps names, tags and identifiers away from context-free engines (GitHub, 2026-10-11)', async () => {
    const { mtSuitable } = await import('../src/background/mt');
    for (const s of ['typescript', 'main', 'kaelvorn', 'electron', 'MIT license', 'CSS', 'README', 'GitHub']) expect(mtSuitable(s, 'tech')).toBe(false);
    for (const s of ['Visual Studio Code', 'Copilot', 'Rust', 'Inno Setup']) expect(mtSuitable(s, 'tech')).toBe(false);
    // Tech pages: nothing goes to machine translation (jargon needs context).
    for (const s of ['Code of conduct', 'Reviews', 'board partner', 'Show more']) expect(mtSuitable(s, 'tech')).toBe(false);
    // Elsewhere ordinary UI phrases are fine.
    for (const s of ['Settings', 'Sign in', 'Pricing', 'Contact Us', 'Show more', 'Oct 7, 2026', '193.5k stars']) expect(mtSuitable(s, 'general')).toBe(true);
    // Bylines, handles, usernames and model numbers are not.
    for (const s of ['16:21 by Pellwick', '14:14 by Nym8ra', '@lena_oak', 'Nym8ra', 'RTX5090', 'typescript', 'MIT license']) expect(mtSuitable(s, 'general')).toBe(false);
  });
});

describe('ProviderGate circuit breaker', () => {
  it('trips after repeated throttling and resets on success', () => {
    let now = 0;
    const g = new ProviderGate(4, 0, () => now);
    g.backoff();
    expect(g.tripped).toBe(false);
    g.backoff();
    expect(g.tripped).toBe(true);
    g.success();
    expect(g.tripped).toBe(false);
    g.backoff();
    g.backoff();
    now = 61_000;
    expect(g.tripped).toBe(false);
  });
});

describe('ProviderGate abort while queued', () => {
  it('rejects a queued caller on abort and keeps the lane accounting right', async () => {
    const g = new ProviderGate(1);
    let release!: () => void;
    const busy = g.run(() => new Promise<void>((r) => (release = r)));
    const ctl = new AbortController();
    const queued = g.run(async () => 'ran', ctl.signal);
    await Promise.resolve();
    ctl.abort();
    await expect(queued).rejects.toThrow('aborted');
    release();
    await busy;
    expect(g.freeLanes).toBe(1);
    expect(await g.run(async () => 'next')).toBe('next');
  });
});
