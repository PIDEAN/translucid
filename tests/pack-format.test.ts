import { describe, expect, it } from 'vitest';
import {
  emptyPack,
  entryKey,
  lookup,
  markStale,
  mergeEntries,
  normalizeKey,
  parsePackFile,
  placeholders,
  scopeMatch,
  selectPack,
  toRuntime,
  translationProblem,
  validatePack,
  type PackIndexItem,
  type SitePack,
} from '../src/pack/format';

const base = (patch: Partial<SitePack> = {}): SitePack => ({
  ...emptyPack('app.example.com', 'zh-CN', 1000),
  entries: [{ kind: 'text', src: 'New chat', t: '新建对话', status: 'auto' }],
  ...patch,
});

describe('normalizeKey', () => {
  it('collapses ASCII whitespace, drops ZWSP/BOM, keeps ZWJ/ZWNJ and NBSP', () => {
    expect(normalizeKey('  New\n\tchat  ')).toBe('New chat');
    expect(normalizeKey('Set​tings﻿')).toBe('Settings');
    expect(normalizeKey('می‌خواهم')).toBe('می‌خواهم');
    expect(normalizeKey('10 GB')).toBe('10 GB');
    expect(normalizeKey('é')).toBe('é');
  });
  it('builds kind-scoped keys', () => {
    expect(entryKey('text', 'Search')).not.toBe(entryKey('placeholder', 'Search'));
  });
});

describe('translation checks', () => {
  it('requires matching placeholders, single line, no markup', () => {
    expect(placeholders('{count} of {0} %s %1$d {{name}} ${x}')).toHaveLength(6);
    expect(translationProblem('{n} messages', '{n} 条消息')).toBeUndefined();
    expect(translationProblem('{n} messages', '条消息')).toBe('placeholders differ');
    expect(translationProblem('Hi', '<img src=x onerror=alert(1)>')).toBe('markup');
    expect(translationProblem('Hi', 'a\nb')).toBe('multi-line');
    expect(translationProblem('Hi', '   ')).toBe('empty');
  });
});

describe('validatePack (imports)', () => {
  it('accepts a valid pack and rebuilds it from known fields only', () => {
    const raw = JSON.parse(JSON.stringify({ ...base(), evil: 1, site: { ...base().site, extra: true } }));
    const r = validatePack(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('evil' in r.pack).toBe(false);
    expect('extra' in r.pack.site).toBe(false);
    expect(r.pack.id).toBe('app.example.com~zh-CN');
  });

  it('rejects wrong format, missing hosts and bad languages', () => {
    expect(validatePack({ format: 'other', version: 1 }).ok).toBe(false);
    const noHost = validatePack({ ...base(), site: { hosts: ['not a host'], scopes: ['/'], name: '', description: '' } });
    expect(noHost.ok).toBe(false);
    expect(validatePack({ ...base(), targetLang: 'xx_YY!' }).ok).toBe(false);
  });

  it('drops dangerous or broken entries with warnings', () => {
    const r = validatePack({
      ...base(),
      entries: [
        { kind: 'text', src: 'Save', t: '<script>alert(1)</script>', status: 'auto' },
        { kind: 'text', src: 'Open', t: '打开‮', status: 'auto' },
        { kind: 'text', src: '{n} files', t: '文件', status: 'auto' },
        { kind: 'onclick', src: 'x', t: 'y', status: 'auto' },
        { kind: 'text', src: 'x'.repeat(200), t: 'y', status: 'auto' },
        { kind: 'text', src: '__proto__', t: '原型', status: 'auto' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const srcs = r.pack.entries.map((e) => e.src);
    expect(srcs).toEqual(['Open', '__proto__']);
    expect(r.pack.entries[0]!.t).toBe('打开'); // bidi override stripped
    expect(r.warnings.length).toBe(4);
    // Prototype-named keys are inert: they are namespaced by kind.
    expect(lookup(toRuntime(r.pack), 'text', '__proto__')).toBe('原型');
    expect(lookup(toRuntime(r.pack), 'text', 'constructor')).toBeUndefined();
  });

  it('keeps the edited entry when two normalize to the same key', () => {
    const r = validatePack({
      ...base(),
      entries: [
        { kind: 'text', src: 'New  chat', t: '新对话', status: 'auto' },
        { kind: 'text', src: 'New chat', t: '新建对话', status: 'edited' },
      ],
    });
    expect(r.ok && r.pack.entries).toEqual([{ kind: 'text', src: 'New chat', t: '新建对话', status: 'edited' }]);
  });

  it('validates selectors, enforces caps and file size', () => {
    const r = validatePack({
      ...base(),
      regions: [{ id: 'r1', label: '侧栏', selector: 'nav[aria-label="Sidebar"]' }, { id: 'r2', label: 'bad', selector: 'div[' }, { id: 'o', label: '弹层', builtin: 'overlays' }],
      excludes: ['.prose', 'a[[['],
    });
    expect(r.ok && r.pack.regions.map((g) => g.id)).toEqual(['r1', 'o']);
    expect(r.ok && r.pack.excludes).toEqual(['.prose']);
    const many = Array.from({ length: 5001 }, (_, i) => ({ kind: 'text', src: `S${i}`, t: `T${i}`, status: 'auto' }));
    expect(validatePack({ ...base(), entries: many }).ok).toBe(false);
    expect(parsePackFile('{').ok).toBe(false);
    expect(parsePackFile('x'.repeat(2 * 1024 * 1024 + 1)).ok).toBe(false);
    expect(parsePackFile(JSON.stringify(base())).ok).toBe(true);
  });
});

describe('merge, stale, runtime, selection', () => {
  it('never overwrites user-edited entries', () => {
    const pack = base({ entries: [{ kind: 'text', src: 'New chat', t: '我的译法', status: 'edited' }] });
    const r = mergeEntries(pack, [
      { kind: 'text', src: 'New chat', t: '新建对话', status: 'auto' },
      { kind: 'placeholder', src: 'Search', t: '搜索', status: 'auto' },
    ], 2000);
    expect(r).toMatchObject({ added: 1, updated: 0, skippedEdited: 1 });
    expect(r.pack.entries.find((e) => e.src === 'New chat')!.t).toBe('我的译法');
    expect(r.pack.generator.updatedAt).toBe(2000);
  });

  it('marks long-unseen auto entries stale', () => {
    const day = 86_400_000;
    const pack = base({ entries: [
      { kind: 'text', src: 'Old', t: '旧', status: 'auto', lastSeen: 0 },
      { kind: 'text', src: 'Kept', t: '保留', status: 'edited', lastSeen: 0 },
      { kind: 'text', src: 'Fresh', t: '新', status: 'auto', lastSeen: 100 * day },
    ] });
    const out = markStale(pack, 100 * day, 60).entries.map((e) => e.status);
    expect(out).toEqual(['stale', 'edited', 'auto']);
  });

  it('picks one pack per page: exact host, most specific scope, newest', () => {
    const item = (id: string, scopes: string[], updatedAt: number, enabled = true): PackIndexItem => ({
      id, hosts: ['app.example.com'], scopes, targetLang: 'zh-CN', enabled, entries: 1, updatedAt,
    });
    const index = [item('root', ['/'], 5), item('settings', ['/settings'], 1), item('newer-root', ['/'], 9), item('off', ['/settings/x'], 99, false)];
    expect(selectPack(index, 'app.example.com', '/settings/profile')!.id).toBe('settings');
    expect(selectPack(index, 'app.example.com', '/chat')!.id).toBe('newer-root');
    expect(selectPack(index, 'other.example.com', '/')).toBeUndefined();
    expect(scopeMatch(['/settings'], '/settingsX')).toBe(-1);
  });
});

describe('format v2: contexts', () => {
  it('upgrades v1 files keeping the authorized scope (regions only, no learning)', () => {
    const v1 = { ...base(), version: 1, options: { hydration: 'after-idle' } };
    const r = validatePack(JSON.parse(JSON.stringify(v1)));
    expect(r.ok && r.pack.version).toBe(2);
    expect(r.ok && r.pack.options).toEqual({ hydration: 'after-idle', learn: false, scope: 'regions' });
    const v2 = validatePack(JSON.parse(JSON.stringify(base())));
    expect(v2.ok && v2.pack.options).toMatchObject({ learn: true, scope: 'auto' });
  });

  it('validates context signatures and caps variants per string', () => {
    const variants = Array.from({ length: 10 }, (_, i) => ({ kind: 'text', src: 'Medium', t: `中${i}`, ctx: `g:abc${i}x`, status: 'auto' }));
    const r = validatePack({ ...base(), entries: [...variants, { kind: 'text', src: 'Bad', t: '坏', ctx: 'nope', status: 'auto' }] });
    expect(r.ok && r.pack.entries.length).toBe(8);
    expect(r.ok && r.warnings.some((w) => w.includes('语境'))).toBe(true);
  });

  it('builds runtime variants and resolves by context, leaving unseen contexts untranslated', async () => {
    const { resolve } = await import('../src/pack/format');
    const pack = base({ entries: [
      { kind: 'text', src: 'Medium', t: '中', ctx: 'g:size1', status: 'auto' },
      { kind: 'text', src: 'Medium', t: '适中宽度', ctx: 'g:wid22', status: 'auto' },
      { kind: 'text', src: 'Settings', t: '设置', status: 'auto' },
    ] });
    const rt = toRuntime(pack);
    expect(rt.ambiguous).toEqual([entryKey('text', 'Medium')]);
    expect(resolve(rt, 'text', 'Medium', () => ['g:wid22', 's:aaaa'])).toBe('适中宽度');
    expect(resolve(rt, 'text', 'Medium', () => ['g:zzzz'])).toBeNull(); // unseen context: not silently translated
    let computed = false;
    expect(resolve(rt, 'text', 'Settings', () => ((computed = true), []))).toBe('设置');
    expect(computed).toBe(false); // no signature work for strings without variants
  });

  it('merges contextual results: shared when they agree, variants when they differ', async () => {
    const { mergeContextual } = await import('../src/pack/format');
    let pack = base({ entries: [] });
    pack = mergeContextual(pack, [
      { kind: 'text', src: 'Theme', t: '主题', ctx: 'g:aaaa' },
      { kind: 'text', src: 'Theme', t: '主题', ctx: 'g:bbbb' },
    ], 1);
    const shared = pack.entries.filter((e) => e.src === 'Theme');
    expect(shared.map((e) => [e.t, e.ctx])).toEqual([['主题', undefined]]);
    expect(pack.contexts[entryKey('text', 'Theme')]).toEqual(['g:aaaa', 'g:bbbb']);

    // A new context disagrees: the shared entry becomes variants for its known contexts.
    pack = mergeContextual(pack, [{ kind: 'text', src: 'Theme', t: '题材', ctx: 'g:cccc' }], 2);
    const theme = pack.entries.filter((e) => e.src === 'Theme').map((e) => [e.ctx, e.t]).sort();
    expect(theme).toEqual([['g:aaaa', '主题'], ['g:bbbb', '主题'], ['g:cccc', '题材']]);
  });

  it('never overwrites edited entries and keeps a legacy shared entry as fallback', async () => {
    const { mergeContextual } = await import('../src/pack/format');
    const pack = base({ entries: [
      { kind: 'text', src: 'Medium', t: '中等（我的）', ctx: 'g:size1', status: 'edited' },
      { kind: 'text', src: 'Open', t: '打开', status: 'auto' }, // v1 entry, contexts unknown
    ] });
    const out = mergeContextual(pack, [
      { kind: 'text', src: 'Medium', t: '中', ctx: 'g:size1' },
      { kind: 'text', src: 'Medium', t: '适中', ctx: 'g:wid22' },
      { kind: 'text', src: 'Open', t: '开启', ctx: 'g:stat1' },
    ], 3);
    expect(out.entries.find((e) => e.ctx === 'g:size1')!.t).toBe('中等（我的）');
    expect(out.entries.find((e) => e.ctx === 'g:wid22')!.t).toBe('适中');
    const open = out.entries.filter((e) => e.src === 'Open');
    expect(open.map((e) => [e.ctx, e.t]).sort()).toEqual([[undefined, '开启']]);
  });
});
