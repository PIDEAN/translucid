import { describe, expect, it } from 'vitest';
import { estimateCost, formatCostLines } from '../src/shared/cost';
import { PROVIDER_PRESETS } from '../src/shared/presets';
import { costOf, defaultPrice, isDeepSeekPeak, peakWindowsIn, ratesAt, resolvedPrice, vendorOf } from '../src/shared/pricing';
import { migrateProviders } from '../src/shared/settings';
import type { ProviderConfig } from '../src/shared/types';

const preset = (id: string, patch: Partial<ProviderConfig> = {}): ProviderConfig => ({ ...PROVIDER_PRESETS.find((p) => p.id === id)!, ...patch });
const utc = (s: string) => new Date(`${s}Z`);

describe('DeepSeek peak hours (Beijing 09–12, 14–18, Mon–Fri)', () => {
  it('flips at the exact boundaries', () => {
    // 2026-10-05 is a Monday.
    expect(isDeepSeekPeak(utc('2026-10-05T00:59:00'))).toBe(false); // 08:59 BJ
    expect(isDeepSeekPeak(utc('2026-10-05T01:00:00'))).toBe(true); // 09:00 BJ
    expect(isDeepSeekPeak(utc('2026-10-05T03:59:00'))).toBe(true); // 11:59 BJ
    expect(isDeepSeekPeak(utc('2026-10-05T04:00:00'))).toBe(false); // 12:00 BJ
    expect(isDeepSeekPeak(utc('2026-10-05T06:00:00'))).toBe(true); // 14:00 BJ
    expect(isDeepSeekPeak(utc('2026-10-05T10:00:00'))).toBe(false); // 18:00 BJ
  });
  it('uses the Beijing date for weekends, not UTC', () => {
    expect(isDeepSeekPeak(utc('2026-10-03T03:00:00'))).toBe(false); // Saturday 11:00 BJ
    expect(isDeepSeekPeak(utc('2026-10-09T17:30:00'))).toBe(false); // Fri UTC, but Sat 01:30 BJ
    expect(isDeepSeekPeak(utc('2026-10-04T23:30:00'))).toBe(false); // Sun UTC = Mon 07:30 BJ
    expect(isDeepSeekPeak(utc('2026-10-05T01:30:00'))).toBe(true); // Mon 09:30 BJ
  });
});

describe('peak windows in the viewer time zone', () => {
  it('converts with weekday shifts and midnight crossings', () => {
    expect(peakWindowsIn(480)).toBe('周一至周五 09:00–12:00、14:00–18:00');
    expect(peakWindowsIn(0)).toBe('周一至周五 01:00–04:00、06:00–10:00');
    expect(peakWindowsIn(540)).toBe('周一至周五 10:00–13:00、15:00–19:00');
    expect(peakWindowsIn(-420)).toBe('周日至周四 18:00–21:00、23:00–次日 03:00');
  });
});

describe('default prices', () => {
  it('follow the DeepSeek region and model', () => {
    const cn = preset('deepseek', { region: 'cn' });
    expect(defaultPrice(cn)).toMatchObject({ currency: '¥', input: 2, cacheHit: 0.04, output: 8, offPeak: { input: 1, cacheHit: 0.02, output: 4 } });
    const gl = preset('deepseek', { region: 'global' });
    expect(defaultPrice(gl)).toMatchObject({ currency: '$', input: 0.3, cacheHit: 0.006, output: 1.2, offPeak: { input: 0.15 } });
    expect(defaultPrice(preset('deepseek', { region: 'global', model: 'deepseek-v4-pro' }))).toMatchObject({ input: 1.32, output: 3.96 });
    // auto: detected region wins, CN until detected
    expect(defaultPrice(preset('deepseek', { region: 'auto' }))?.currency).toBe('¥');
    expect(defaultPrice(preset('deepseek', { region: 'auto', detectedRegion: 'global' }))?.currency).toBe('$');
    expect(defaultPrice(preset('deepseek', { region: 'cn', detectedRegion: 'global' }))?.currency).toBe('¥');
  });
  it('covers the other presets', () => {
    expect(defaultPrice(preset('gemini'))).toMatchObject({ input: 0.25, cacheHit: 0.025, output: 1.5 });
    expect(defaultPrice(preset('glm'))).toMatchObject({ input: 0, output: 0, currency: '¥' });
    expect(defaultPrice(preset('glm-global'))).toMatchObject({ input: 0, output: 0, currency: '$' });
    expect(defaultPrice(preset('opencode-zen'))).toMatchObject({ input: 0.3, output: 1.2 });
    expect(defaultPrice(preset('opencode-go'))?.subscription).toBeDefined();
    expect(defaultPrice(preset('custom', { model: 'gpt-x' }))).toBeUndefined();
  });
  it('lets overrides win and empty fields fall back', () => {
    const p = preset('deepseek', { region: 'global', price: { input: 0.5, offOutput: 0.1 } });
    expect(resolvedPrice(p)).toMatchObject({ input: 0.5, cacheHit: 0.006, output: 1.2, offPeak: { input: 0.15, output: 0.1 } });
  });
  it('infers the vendor from old base URLs', () => {
    expect(vendorOf({ baseURL: 'https://api.deepseek.com/v1' })).toBe('deepseek');
    expect(vendorOf({ baseURL: 'https://opencode.ai/zen/go/v1' })).toBe('opencode-go');
    expect(vendorOf({ baseURL: 'https://opencode.ai/zen/v1' })).toBe('opencode-zen');
    expect(vendorOf({ baseURL: 'https://api.z.ai/api/paas/v4' })).toBe('glm-global');
  });
});

describe('costing', () => {
  const usage = { promptTokens: 1_000_000, cacheHitTokens: 500_000, completionTokens: 1_000_000 };
  it('charges peak or off-peak rates by request time', () => {
    const spec = resolvedPrice(preset('deepseek', { region: 'cn' }));
    // miss 0.5M × ¥2 + hit 0.5M × ¥0.04 + out 1M × ¥8 = 9.02 at peak
    expect(costOf(usage, spec, utc('2026-10-05T02:00:00'))).toBeCloseTo(9.02);
    expect(costOf(usage, spec, utc('2026-10-03T02:00:00'))).toBeCloseTo(4.51);
    expect(ratesAt(spec, utc('2026-10-03T02:00:00')).period).toBe('offpeak');
  });
  it('bills nothing for subscriptions', () => {
    expect(costOf(usage, resolvedPrice(preset('opencode-go')))).toBe(0);
  });
  it('sums per currency', () => {
    expect(formatCostLines([{ amount: 0.42, currency: '¥' }, { amount: 0.13, currency: '$' }, { amount: 0.1, currency: '¥' }])).toBe('¥0.52 + $0.13');
    expect(formatCostLines([], '¥')).toBe('¥0.00');
  });
  it('uses recorded cost when present, peak estimate for legacy buckets', () => {
    const p = preset('deepseek', { region: 'global' });
    expect(estimateCost({ requests: 1, promptTokens: 1e6, cacheHitTokens: 0, completionTokens: 0, cost: 0.12, currency: '$' }, p)).toEqual({ amount: 0.12, currency: '$' });
    expect(estimateCost({ requests: 1, promptTokens: 1e6, cacheHitTokens: 0, completionTokens: 0 }, p).amount).toBeCloseTo(0.3);
  });
});

describe('settings migration', () => {
  it('drops legacy preset prices, keeps custom ones, adds new presets', () => {
    const old: ProviderConfig[] = [
      { id: 'deepseek', name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk', model: 'deepseek-flash', extraBody: {}, includeUsage: true, concurrency: 6, price: { input: 0.3, cacheHit: 0.006, output: 1.2, currency: '$' } },
      { id: 'gemini', name: 'Gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: '', model: 'gemini-3.1-flash-lite', extraBody: {}, includeUsage: true, concurrency: 4, price: { input: 9, cacheHit: 0.025, output: 1.5, currency: '$' } },
    ];
    const out = migrateProviders(old);
    const ds = out.find((p) => p.id === 'deepseek')!;
    expect(ds.price).toBeUndefined();
    expect(ds.apiKey).toBe('sk');
    expect(ds.vendor).toBe('deepseek');
    expect(ds.region).toBe('auto');
    expect(out.find((p) => p.id === 'gemini')!.price?.input).toBe(9);
    expect(out.map((p) => p.id)).toEqual(expect.arrayContaining(['glm-global', 'opencode-zen', 'opencode-go', 'custom']));
  });
});
