import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyPack, toRuntime, type PackRuntime } from '../src/pack/format';
import type { StructuredCandidate } from '../src/pack/harvest';
import { Learner, LEARN_LIMITS } from '../src/pack/learner';
import { packRegistry } from '../src/pack/registry';
import { claudeSettings, sidebar, userCards } from './fixtures/ui-structures';

const runtime = (patch: Partial<PackRuntime> = {}): PackRuntime => ({
  ...toRuntime({ ...emptyPack('app.example.com', 'zh-CN'), options: { hydration: 'after-idle', learn: true, scope: 'auto' } }),
  ...patch,
});

let got: StructuredCandidate[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  got = [];
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  packRegistry().scanning = false;
});

const offerAll = (l: Learner) => {
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue!.trim()) l.offer('text', n.nodeValue!.trim(), n.parentElement!);
};

describe('Learner', () => {
  it('learns interface strings with context during normal use, never content', () => {
    document.body.innerHTML = claudeSettings('general') + sidebar + userCards;
    const l = new Learner(() => runtime(), (c) => got.push(c));
    offerAll(l);
    vi.advanceTimersByTime(LEARN_LIMITS.delayMs);
    const srcs = got.map((c) => c.src);
    expect(srcs).toContain('Transcript width');
    expect(got.filter((c) => c.src === 'Medium')).toHaveLength(2);
    expect(got.every((c) => c.source === 'learn' && c.ctx)).toBe(true);
    for (const s of ['Mira Chen', 'MC', 'Weekly digest', 'Trip planning with Mira']) expect(srcs).not.toContain(s);
  });

  it('without automatic learning only approved regions count', () => {
    document.body.innerHTML = claudeSettings('general') + sidebar;
    const rt = runtime({ learn: false, scope: 'regions', regions: [{ id: 'side', label: '侧栏', selector: 'aside' }] });
    const l = new Learner(() => rt, (c) => got.push(c));
    offerAll(l);
    vi.advanceTimersByTime(LEARN_LIMITS.delayMs);
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((c) => c.region === 'side' && c.source === 'pick')).toBe(true);
    expect(got.map((c) => c.src)).not.toContain('Transcript width');
  });

  it('pauses during a scan and is rate limited', () => {
    document.body.innerHTML = '<nav>' + Array.from({ length: 150 }, (_, i) => `<button>Action number ${i}</button>`).join('') + '</nav>';
    const l = new Learner(() => runtime(), (c) => got.push(c));
    packRegistry().scanning = true;
    offerAll(l);
    vi.advanceTimersByTime(LEARN_LIMITS.delayMs);
    expect(got).toHaveLength(0);
    packRegistry().scanning = false;
    offerAll(l);
    vi.advanceTimersByTime(LEARN_LIMITS.delayMs);
    expect(got).toHaveLength(LEARN_LIMITS.perMinute);
  });
});

describe('pending pool v2', () => {
  it('knows when a string appears in a new context of an ambiguous key', async () => {
    const { knownState } = await import('../src/background/pack-pending');
    const pack = { ...emptyPack('app.example.com', 'zh-CN'), entries: [
      { kind: 'text' as const, src: 'Medium', t: '中', ctx: 'g:aaaa', status: 'auto' as const },
      { kind: 'text' as const, src: 'Settings', t: '设置', status: 'auto' as const },
    ] };
    expect(knownState(pack, 'text', 'Medium', 'g:aaaa')).toBe('known');
    expect(knownState(pack, 'text', 'Medium', 'g:bbbb')).toBe('new-context');
    expect(knownState(pack, 'text', 'Settings', 'g:cccc')).toBe('known'); // a shared translation covers new places
    expect(knownState(pack, 'text', 'Open', 'g:cccc')).toBe('new');
  });

  it('sanitizes structure metadata and never raises the tier above what flags allow', async () => {
    const { sanitizeCandidates } = await import('../src/background/pack-pending');
    const pack = { ...emptyPack('app.example.com', 'zh-CN'), options: { hydration: 'after-idle' as const, learn: true, scope: 'auto' as const } };
    const out = sanitizeCandidates(pack, [
      { kind: 'text', src: 'Medium', region: 'auto', flags: [], tier: 'high', ctx: 'g:abcd', where: { group: 'Transcript width', section: 'mira@example.org', role: 'radio' }, source: 'learn' },
      { kind: 'text', src: 'MIRACHEN', region: 'auto', flags: [], tier: 'high' },
      { kind: 'text', src: 'X', region: 'auto', flags: [], tier: 'high', ctx: 'bad ctx' },
      { kind: 'text', src: 'Nope', region: 'elsewhere', flags: [], tier: 'high' },
    ]);
    expect(out[0]).toMatchObject({ ctx: 'g:abcd', tier: 'high', source: 'learn', where: { group: 'Transcript width', role: 'radio' } });
    expect(out[0]!.where!.section).toBeUndefined();
    expect(out.find((c) => c.src === 'MIRACHEN')!.tier).toBe('uncertain');
    expect(out.find((c) => c.src === 'X')!.ctx).toBeUndefined();
    expect(out.some((c) => c.src === 'Nope')).toBe(false);
    // 'auto' is only a valid region for packs with automatic scope.
    const regionsOnly = { ...emptyPack('app.example.com', 'zh-CN'), options: { hydration: 'after-idle' as const, learn: false, scope: 'regions' as const } };
    expect(sanitizeCandidates(regionsOnly, [{ kind: 'text', src: 'Medium', region: 'auto', flags: [] }])).toEqual([]);
  });
});
