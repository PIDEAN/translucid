// Regressions for the independent review of site localization v2 (privacy, structure, applier, explorer).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyPack, entryKey, mergeContextual, resolve, toRuntime, validatePack, type PackEntry } from '../src/pack/format';
import { hrefLooksPersonal, scrubForExport } from '../src/pack/privacy';
import { buildSelector } from '../src/pack/selector';
import { classify, contentAt } from '../src/pack/classify';
import { consolidate, unitsOf, type Occurrence } from '../src/pack/units';

afterEach(() => {
  document.body.innerHTML = '';
  history.replaceState(null, '', '/');
  vi.useRealTimers();
});

describe('format and privacy boundaries', () => {
  it('validatePack drops contact data everywhere and context keys of strings it does not hold', () => {
    const r = validatePack({
      ...emptyPack('app.example.com', 'zh-CN'),
      entries: [
        { kind: 'text', src: 'mira.chen@example.org', t: '邮箱', status: 'auto' },
        { kind: 'text', src: 'Open', t: '打开', status: 'auto' },
      ],
      contexts: { [entryKey('text', 'mira.chen@example.org')]: ['g:abcd'], [entryKey('text', 'Open')]: ['g:efgh'] },
      surfaces: [{ key: 'k1', kind: 'menu', label: 'mira.chen@example.org' }],
      regions: [{ id: 'r1', label: 'x', selector: '[data-testid="mira.chen@example.org"]' }],
      excludes: ['[data-user="mira.chen@example.org"]', '.prose'],
      glossary: [{ src: 'mira.chen@example.org', tgt: 'x' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pack.entries.map((e) => e.src)).toEqual(['Open']);
    expect(Object.keys(r.pack.contexts)).toEqual([entryKey('text', 'Open')]);
    expect(r.pack.surfaces[0]!.label).toBeUndefined();
    expect(r.pack.regions).toEqual([]);
    expect(r.pack.excludes).toEqual(['.prose']);
    expect(r.pack.glossary).toEqual([]);
  });

  it('export is rebuilt from checked fields: no orphaned context keys, personal surfaces or excludes', () => {
    const pack = {
      ...emptyPack('app.example.com', 'zh-CN'),
      entries: [
        { kind: 'text' as const, src: 'Open', t: '打开', status: 'auto' as const },
        { kind: 'text' as const, src: 'MIRACHEN', t: '名字', status: 'auto' as const },
      ],
      contexts: { [entryKey('text', 'Open')]: ['g:aaaa'], [entryKey('text', 'MIRACHEN')]: ['g:bbbb'] },
      surfaces: [{ key: 'k', kind: 'menu', label: 'mira.chen@example.org' }],
      excludes: ['[aria-label="mira.chen@example.org"]', '.chat-list'],
    };
    const out = JSON.stringify(scrubForExport(pack).pack);
    for (const leak of ['MIRACHEN', 'mira.chen', 'example.org']) expect(out).not.toContain(leak);
    expect(out).toContain('.chat-list');
    expect(scrubForExport(pack).pack.contexts).toEqual({ [entryKey('text', 'Open')]: ['g:aaaa'] });
  });

  it('odd URLs never throw while classifying links', () => {
    expect(() => hrefLooksPersonal('/settings?ref=%25')).not.toThrow();
    expect(() => hrefLooksPersonal('/settings/%ZZ')).not.toThrow();
    expect(hrefLooksPersonal('/settings/%ZZ')).toBe(true); // undecodable segment: treated as an id
  });

  it('selectors never carry contact data or names from test ids', () => {
    document.body.innerHTML = '<nav data-testid="mira.chen@example.org"><button>x</button></nav><div data-testid="sidebar"><p>y</p></div>';
    expect(buildSelector(document.querySelector('nav')!) ?? '').not.toContain('mira');
    expect(buildSelector(document.querySelector('[data-testid="sidebar"]')!)).toContain('sidebar');
  });

  it('merges per-context translations back into one when they come to agree', () => {
    let pack = { ...emptyPack('app.example.com', 'zh-CN'), entries: [] as PackEntry[] };
    pack = mergeContextual(pack, [{ kind: 'text', src: 'Medium', t: '中', ctx: 'g:aaaa' }, { kind: 'text', src: 'Medium', t: '适中', ctx: 'g:bbbb' }], 1);
    expect(pack.entries.filter((e) => e.ctx)).toHaveLength(2);
    pack = mergeContextual(pack, [{ kind: 'text', src: 'Medium', t: '适中', ctx: 'g:aaaa' }], 2);
    expect(pack.entries.map((e) => [e.ctx, e.t])).toEqual([[undefined, '适中']]);
    expect(resolve(toRuntime(pack), 'text', 'Medium', () => ['g:cccc'])).toBe('适中');
  });
});

describe('content stays content', () => {
  it('a single card with its own menu is an item; per-row button titles are not interface', () => {
    document.body.innerHTML = `<main><div class="card"><h3 id="t">My travel connector</h3><button type="button" aria-haspopup="menu" aria-label="More options" id="m"></button></div>
      <ul><li><button type="button" id="b">Quarterly plan for Mira</button><span>x</span><time>2d</time></li></ul></main>`;
    const tier = (id: string, kind: 'text' | 'aria-label' = 'text') => {
      const el = document.getElementById(id)!;
      return classify(el, kind, kind === 'text' ? el.textContent! : el.getAttribute(kind)!, 'zh-CN')?.tier;
    };
    expect(tier('t')).toBe('content');
    expect(tier('m', 'aria-label')).toBe('high');
    expect(tier('b')).toBe('content');
    expect(contentAt(document.getElementById('b')!, 'text', 'Quarterly plan for Mira')).toBe(true);
  });

  it('feeds and documents are protected at apply time as at collection', () => {
    document.body.innerHTML = '<div role="feed"><span id="s">Settings</span><button id="c">Copy</button></div>';
    expect(contentAt(document.getElementById('s')!, 'text', 'Settings')).toBe(true);
    expect(contentAt(document.getElementById('c')!, 'text', 'Copy')).toBe(false);
  });

  it('a card title used as a section heading never becomes a structure label', async () => {
    const { collect } = await import('../src/pack/harvest');
    document.body.innerHTML = `<main><div class="card"><h3>Weekend in Lisbon</h3><button type="button" aria-haspopup="menu" aria-label="More options"></button>
      <div role="group" aria-label="Visibility"><span role="radio">Private</span></div></div></main>`;
    const got = collect(document, { scope: 'auto', regions: [], targetLang: 'zh-CN', exclude: '' }).candidates;
    expect(JSON.stringify(got)).not.toContain('Lisbon');
  });
});

describe('item menus never take user text as their question', () => {
  it('the menu of a user card is not labelled by the card description', async () => {
    const { collect } = await import('../src/pack/harvest');
    document.body.innerHTML = `<main><div class="grid"><div class="card"><h4>weekly-digest</h4><p>Summarizes my week for Mira</p>
      <button type="button" aria-haspopup="menu" aria-expanded="true" aria-label="More options"></button></div></div></main>
      <div role="menu"><div role="menuitem">Edit skill</div><div role="menuitem">Remove skill</div></div>`;
    const got = collect(document, { scope: 'auto', regions: [], targetLang: 'zh-CN', exclude: '' }).candidates;
    expect(JSON.stringify(got)).not.toContain('Summarizes');
    expect(got.find((c) => c.src === 'Edit skill')?.where?.group).not.toBe('Summarizes my week for Mira');
  });
});

describe('learning and grouping', () => {
  it('a node recycled before processing is not learned with its old text', async () => {
    vi.useFakeTimers();
    const { Learner, LEARN_LIMITS } = await import('../src/pack/learner');
    const rt = { ...toRuntime({ ...emptyPack('app.example.com', 'zh-CN') }), learn: true, scope: 'auto' as const };
    document.body.innerHTML = '<nav><button id="b">Mira Chen</button></nav>';
    const got: string[] = [];
    const l = new Learner(() => rt, (c) => got.push(c.src));
    const b = document.getElementById('b')!;
    l.offer('text', 'Mira Chen', b);
    b.textContent = 'Settings';
    for (let i = 0; i < 20; i++) l.offer('text', 'Settings', b); // repeated misses of one node cost nothing
    document.body.insertAdjacentHTML('beforeend', '<div role="dialog" aria-label="Prefs"><button id="o">Settings</button></div>');
    l.offer('text', 'Settings', document.getElementById('o')!);
    vi.advanceTimersByTime(LEARN_LIMITS.delayMs);
    expect(got).not.toContain('Mira Chen');
    expect(got.filter((s) => s === 'Settings')).toHaveLength(2); // two places, two contexts
  });

  it('a question rendered across a portal is one translation unit', () => {
    const w = (surface: string, role: string) => ({ surface, section: 'Account', group: 'What best describes your work?', groupRole: 'select', role });
    const occ = (src: string, surface: string, role: string): Occurrence => ({ key: `${src}${surface}`, kind: 'text', src, region: 'auto', area: 'x', ctx: 'g:work1', where: w(surface, role) });
    const items = consolidate([occ('What best describes your work?', 'dialog: Settings', 'label'), occ('Engineering', 'dialog: Settings', 'value'), occ('Design', 'listbox', 'option'), occ('Research', 'listbox', 'option')]);
    const units = unitsOf(items);
    expect(units).toHaveLength(1);
    expect(units[0]!.ids.map((i) => items[i]!.src)).toEqual(['What best describes your work?', 'Engineering', 'Design', 'Research']);
  });
});
