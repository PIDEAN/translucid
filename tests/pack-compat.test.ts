// Structures common on productivity sites beyond the Claude / Devin shapes: native forms
// (GitHub-style), title + description | control rows without ARIA groups (Linear-style),
// native <select>, tables of members, navigation sidebars in <aside>.
import { afterEach, describe, expect, it } from 'vitest';
import { collect, type StructuredCandidate } from '../src/pack/harvest';
import { consolidate } from '../src/pack/units';
import { buildOutline, outlineOrder } from '../src/prompt/ui-locale';
import { githubSettings, linearSettings } from './fixtures/ui-structures';

afterEach(() => {
  document.body.innerHTML = '';
  history.replaceState(null, '', '/');
});

function scan(html: string, path: string) {
  history.replaceState(null, '', path);
  document.body.innerHTML = html;
  const { candidates } = collect(document, { scope: 'auto', regions: [], targetLang: 'zh-CN', exclude: '' });
  const by = (src: string) => candidates.filter((c) => c.src === src);
  const one = (src: string) => by(src)[0] as StructuredCandidate;
  const high = candidates.filter((c) => c.tier === 'high');
  const items = consolidate(high.map((c) => ({ key: `${c.src}${c.ctx}`, kind: c.kind, src: c.src, region: c.region, area: 'x', ctx: c.ctx, where: c.where })));
  const order = outlineOrder(items);
  const outline = buildOutline(order.map((i) => items[i]!), [], new Set(items.map((i) => i.src)));
  return { candidates, by, one, outline };
}

describe('GitHub-style native settings forms', () => {
  it('groups native selects, fieldsets and checkboxes with their labels and descriptions', () => {
    const { one, by, outline } = scan(githubSettings, '/settings/appearance');
    expect(one('Light').where).toMatchObject({ group: 'Emoji skin tone preference', groupRole: 'select', role: 'option' });
    expect(one('Preferred default emoji skin tone.').where).toMatchObject({ group: 'Emoji skin tone preference', role: 'description' });
    expect(one('Sync with system').where).toMatchObject({ group: 'Theme mode', role: 'radio' });
    expect(one('Limit animations across the site.').where).toMatchObject({ group: 'Reduce motion', role: 'description' });
    expect(one('Accessibility').where).toMatchObject({ groupRole: 'nav', role: 'link' });
    expect(one('Accessibility').where?.section).toBeUndefined();
    expect(by('2')).toEqual([]); // numbers stay as they are
    // The outline keeps each question whole and in page order.
    expect(outline).toMatch(/select <\d+>Emoji skin tone preference<\/\d+>\n\s+opt <\d+>Default<\/\d+>\n\s+opt <\d+>Light<\/\d+>\n\s+opt <\d+>Medium<\/\d+>\n\s+opt <\d+>Dark<\/\d+>\n\s+description <\d+>Preferred default emoji skin tone\.<\/\d+>/);
    const ids = [...outline.matchAll(/<(\d+)>/g)].map((m) => Number(m[1]));
    expect(ids).toEqual(ids.map((_, i) => i + 1));
  });

  it('keeps member tables out: names are data, repeated roles are only candidates', () => {
    const { by, one } = scan(githubSettings, '/settings/appearance');
    for (const s of ['Mira Chen', 'Jonas Weber', 'Ana Ruiz', '@mira-chen']) expect(by(s)).toEqual([]);
    expect(one('Member').tier).toBe('uncertain');
    expect(one('Role').where?.role).toBe('heading');
  });

  it('applies translations to native option labels without touching their values', async () => {
    const { PackApplier } = await import('../src/pack/applier');
    const { emptyPack, toRuntime } = await import('../src/pack/format');
    document.body.innerHTML = '<label for="s">Theme</label><select id="s"><option value="light">Light</option><option value="dark">Dark</option></select>';
    const a = new PackApplier(document, toRuntime({ ...emptyPack('x.example.com', 'zh-CN'), entries: [{ kind: 'text', src: 'Dark', t: '深色', status: 'auto' }] }));
    a.start();
    const opt = document.querySelector('option[value="dark"]') as HTMLOptionElement;
    expect(opt.text).toBe('深色');
    expect(opt.value).toBe('dark');
    a.restore();
    expect(opt.text).toBe('Dark');
  });
});

describe('Linear-style rows without ARIA groups', () => {
  it('a row title, its description and its options form one question', () => {
    const { one, by, outline } = scan(linearSettings, '/settings/account/preferences');
    expect(one('Display density').where).toMatchObject({ group: 'Display density', groupRole: 'radiogroup', role: 'label' });
    expect(one('How much space items take up.').where).toMatchObject({ group: 'Display density', role: 'description' });
    expect(one('Comfortable').where).toMatchObject({ group: 'Display density', role: 'radio' });
    // Two "Medium"-like answers in different rows keep different contexts.
    expect(one('Medium').where?.group).toBe('Font size');
    expect(one('Inbox').where).toMatchObject({ group: 'Home view', groupRole: 'select' });
    expect(one('Open in desktop app').tier).toBe('high');
    // The active nav item is interface, not an organization name from the address.
    expect(by('Preferences').some((c) => c.where?.groupRole === 'nav')).toBe(true);
    expect(one("Acme's Workspace").tier).toBe('uncertain');
    expect(outline).toMatch(/radios <\d+>Display density<\/\d+>\n\s+description <\d+>How much space items take up\.<\/\d+>\n\s+opt <\d+>Compact<\/\d+>\n\s+opt <\d+>Comfortable<\/\d+>/);
    expect(outline).toMatch(/nav "Account"\n\s+link <\d+>Preferences<\/\d+>/);
  });
});
