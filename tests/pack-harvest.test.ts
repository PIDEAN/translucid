import { afterEach, describe, expect, it } from 'vitest';
import type { PackRegion } from '../src/pack/format';
import { collect, regionOf, type CollectOptions } from '../src/pack/harvest';
import { buildSelector, regionLabel } from '../src/pack/selector';

afterEach(() => (document.body.innerHTML = ''));

const PAGE = `
  <nav aria-label="Sidebar" data-testid="sidebar">
    <button>New chat</button>
    <input placeholder="Search chats">
    <a href="/projects">Projects</a>
    <a href="/chat/3f2b8c1e-9a7d-4e21-b5c3-0d9e8f7a6b5c">Trip planning with Mira</a>
    <a href="/c/a1b2c3">Budget review</a>
    <div class="recent">Weekly sync notes</div>
    <span class="material-icons">settings</span>
    <div class="profile">mira.chen@example.org</div>
    <input type="password" value="hunter2"><input type="text" value="draft message"><input type="submit" value="Send">
  </nav>
  <main>
    <div class="prose"><p>A message the user wrote that should never be collected.</p><button>Copy</button></div>
    <button>Outside region</button>
  </main>
  <div role="menu"><div role="menuitem">Rename</div><div role="menuitem" title="Delete forever">Delete</div></div>`;

const harvest = (doc: Document, regions: PackRegion[], opts: Pick<CollectOptions, 'targetLang' | 'exclude'>) =>
  collect(doc, { ...opts, scope: 'regions', regions }).candidates;

describe('collect in approved regions', () => {
  const regions: PackRegion[] = [
    { id: 'side', label: '侧栏', selector: '[data-testid="sidebar"]' },
    { id: 'ov', label: '弹层', builtin: 'overlays' },
  ];

  it('collects only inside approved regions, with privacy flags', () => {
    document.body.innerHTML = PAGE;
    const got = harvest(document, regions, { targetLang: 'zh-CN', exclude: '.recent' });
    const by = (src: string) => got.find((c) => c.src === src);
    const srcs = got.map((c) => `${c.kind}:${c.src}`);
    expect(srcs).toEqual(
      expect.arrayContaining(['text:New chat', 'placeholder:Search chats', 'text:Projects', 'value:Send', 'text:Rename', 'text:Delete', 'title:Delete forever']),
    );
    // Never read: outside regions, user content, excluded areas, icon ligatures, form values, passwords.
    for (const s of ['Outside region', 'Copy', 'A message the user wrote that should never be collected.', 'Weekly sync notes', 'settings', 'hunter2', 'draft message']) {
      expect(srcs.some((x) => x.endsWith(`:${s}`))).toBe(false);
    }
    // Hard flags (links to one specific item, contact data) are dropped, not even kept for review.
    expect(by('Trip planning with Mira')).toBeUndefined();
    expect(by('Budget review')).toBeUndefined();
    expect(by('mira.chen@example.org')).toBeUndefined();
    expect(by('New chat')!.flags).toEqual([]);
    expect(by('Rename')!.region).toBe('ov');
  });

  it('maps elements to their region and skips strings the pack already translated', async () => {
    document.body.innerHTML = PAGE;
    expect(regionOf(document.querySelector('[role="menuitem"]')!, regions)!.id).toBe('ov');
    expect(regionOf(document.querySelector('main button')!, regions)).toBeUndefined();
    const { PackApplier } = await import('../src/pack/applier');
    const { emptyPack, toRuntime } = await import('../src/pack/format');
    const a = new PackApplier(document, toRuntime({ ...emptyPack('x.example.com', 'zh-CN'), entries: [{ kind: 'text', src: 'New chat', t: '新建对话', status: 'auto' }] }));
    a.start();
    const got = harvest(document, regions, { targetLang: 'zh-CN', exclude: '' });
    expect(got.some((c) => c.src === 'New chat' || c.src === '新建对话')).toBe(false);
    a.restore();
  });
});

describe('collect with structure (automatic scope)', () => {
  it('tags each occurrence with context and place; content is only counted', async () => {
    const { claudeSettings, sidebar, userCards } = await import('./fixtures/ui-structures');
    document.body.innerHTML = claudeSettings('general') + sidebar + userCards;
    const { candidates, content } = collect(document, { scope: 'auto', regions: [], targetLang: 'zh-CN', exclude: '' });
    const medium = candidates.filter((c) => c.src === 'Medium');
    expect(medium).toHaveLength(2);
    expect(new Set(medium.map((m) => m.ctx)).size).toBe(2);
    expect(medium.map((m) => m.where?.group).sort()).toEqual(['Transcript text size', 'Transcript width']);
    expect(medium[0]!.where).toMatchObject({ section: 'General', groupRole: 'radiogroup', role: 'radio' });
    const srcs = candidates.map((c) => c.src);
    for (const s of ['Mira Chen', 'MC', 'Weekly digest', 'Summarizes my week', 'Trip planning with Mira']) expect(srcs).not.toContain(s);
    expect(content).toBeGreaterThan(3);
    expect(candidates.find((c) => c.src === 'Transcript width')!.tier).toBe('high');
    expect(candidates.find((c) => c.src === 'Enabled')!.tier).toBe('uncertain');
  });

  it('reads translated nodes from their originals when asked', async () => {
    const { PackApplier } = await import('../src/pack/applier');
    const { emptyPack, toRuntime } = await import('../src/pack/format');
    document.body.innerHTML = '<nav><button>New chat</button></nav>';
    const a = new PackApplier(document, toRuntime({ ...emptyPack('x.example.com', 'zh-CN'), entries: [{ kind: 'text', src: 'New chat', t: '新建对话', status: 'auto' }] }));
    a.start();
    const got = collect(document, { scope: 'auto', regions: [], targetLang: 'zh-CN', exclude: '', includeOwned: true }).candidates;
    expect(got.map((c) => c.src)).toEqual(['New chat']);
    a.restore();
  });
});

describe('stringsIn (retroactive excludes)', () => {
  it('lists every string inside the given areas', async () => {
    const { stringsIn } = await import('../src/pack/harvest');
    document.body.innerHTML = '<div class="recent"><a href="/c/x1y2z3">Weekly sync notes</a><button title="More">⋯</button></div><p>Outside</p>';
    expect(stringsIn(document, ['.recent'])).toEqual([
      { kind: 'text', src: 'Weekly sync notes' },
      { kind: 'title', src: 'More' },
      { kind: 'text', src: '⋯' },
    ]);
  });
});

describe('buildSelector', () => {
  it('prefers test ids, ARIA and landmarks over position, and avoids hashed classes and ids', () => {
    document.body.innerHTML = `
      <nav aria-label="Sidebar"><ul class="css-1x2y3z"><li>a</li></ul></nav>
      <aside><div class="settings-panel" id="radix-:r12:">x</div></aside>
      <div data-testid="composer-toolbar"><span>y</span></div>
      <div role="toolbar" aria-label="Formatting">z</div>
      <section><div><div class="sc-abc12">deep</div></div></section>`;
    expect(buildSelector(document.querySelector('nav')!)).toBe('nav[aria-label="Sidebar"]');
    expect(buildSelector(document.querySelector('.settings-panel')!)).toBe('div.settings-panel');
    expect(buildSelector(document.querySelector('[data-testid]')!)).toBe('[data-testid="composer-toolbar"]');
    expect(buildSelector(document.querySelector('[role="toolbar"]')!)).toBe('[role="toolbar"][aria-label="Formatting"]');
    expect(buildSelector(document.querySelector('ul')!)).toBe('nav[aria-label="Sidebar"] ul');
    expect(buildSelector(document.querySelector('.sc-abc12')!)).toBeUndefined();
  });

  it('rejects per-render ids and utility classes (claude.ai, 2026-10-11)', () => {
    document.body.innerHTML = `
      <aside aria-label="Sidebar"><div id="frame-peek-popover" data-testid="sidebar"><div data-testid="nav-pin-rows"><a><span class="min-w-0 truncate">Artifacts</span></a></div></div></aside>
      <div id="_r_cb_"><span class="absolute duration-200">x</span></div>
      <button id="base-ui-_r_9_" aria-label="More navigation items">⋯</button>
      <div class="flex min-w-0 dframe-nav-scroll"><span>y</span></div>`;
    expect(buildSelector(document.querySelector('[data-testid="nav-pin-rows"]')!)).toBe('[data-testid="nav-pin-rows"]');
    expect(buildSelector(document.querySelector('aside')!)).toBe('aside[aria-label="Sidebar"]');
    expect(buildSelector(document.querySelector('#_r_cb_ span')!)).toBeUndefined();
    expect(buildSelector(document.querySelector('[aria-label="More navigation items"]')!) ?? '').not.toContain('base-ui');
    expect(buildSelector(document.querySelector('.dframe-nav-scroll')!)).toBe('div.dframe-nav-scroll');
  });

  it('labels regions from structure, never from personal text', () => {
    document.body.innerHTML = '<nav aria-label="Sidebar"></nav><div role="dialog" aria-label="mira.chen@example.org"></div>';
    expect(regionLabel(document.querySelector('nav')!)).toBe('导航（Sidebar）');
    expect(regionLabel(document.querySelector('[role="dialog"]')!)).toBe('对话框');
  });
});
