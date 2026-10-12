import { describe, expect, it } from 'vitest';
import { buildOutline, buildUiBatchMessages } from '../src/prompt/ui-locale';
import { approvedLabels, batchUnits, consolidate, retryBatches, reviewRowKey, unitsOf, type Occurrence } from '../src/pack/units';

const settings = 'dialog: Settings';
const occ = (src: string, where: Occurrence['where'], ctx?: string): Occurrence => ({
  key: `text\u0001${src}${ctx ? '\u0002' + ctx : ''}`, kind: 'text', src, region: 'auto', area: 'interface', ...(ctx ? { ctx } : {}), where,
});
const general = { surface: settings, section: 'General' };
const OCC: Occurrence[] = [
  occ('General', { ...general, role: 'button', groupRole: 'nav' }, 's:nav1'),
  occ('Transcript text size', { ...general, group: 'Transcript text size', groupRole: 'radiogroup', role: 'label' }, 'g:size1'),
  occ('Small', { ...general, group: 'Transcript text size', groupRole: 'radiogroup', role: 'radio' }, 'g:size1'),
  occ('Medium', { ...general, group: 'Transcript text size', groupRole: 'radiogroup', role: 'radio' }, 'g:size1'),
  occ('Transcript width', { ...general, group: 'Transcript width', groupRole: 'radiogroup', role: 'label' }, 'g:wid22'),
  occ('Medium', { ...general, group: 'Transcript width', groupRole: 'radiogroup', role: 'radio' }, 'g:wid22'),
  occ('Wide', { ...general, group: 'Transcript width', groupRole: 'radiogroup', role: 'radio' }, 'g:wid22'),
  occ('What best describes your work?', { surface: settings, section: 'Account', group: 'What best describes your work?', groupRole: 'select', role: 'label' }, 'g:work1'),
  occ('Engineering', { surface: settings, section: 'Account', group: 'What best describes your work?', groupRole: 'select', role: 'value' }, 'g:work1'),
  occ('Engineering', { surface: 'listbox', section: 'Account', group: 'What best describes your work?', groupRole: 'select', role: 'option' }, 'g:work1'),
  occ('Settings', { surface: 'page', role: 'button' }, 's:side1'),
  occ('Settings', { surface: 'menu', role: 'menuitem' }, 's:menu1'),
];

describe('consolidate', () => {
  it('keeps contexts for answers, shares everything else', () => {
    const items = consolidate(OCC);
    const medium = items.filter((i) => i.src === 'Medium');
    expect(medium.map((m) => m.ctx)).toEqual(['g:size1', 'g:wid22']);
    // "Settings" button and menu item are one translation, applied to both places.
    const s = items.filter((i) => i.src === 'Settings');
    expect(s).toHaveLength(1);
    expect(s[0]!.ctx).toBeUndefined();
    expect(s[0]!.members).toEqual(['s:side1', 's:menu1']);
    // The dropdown value and the same option in the open list are one occurrence of one question.
    const eng = items.filter((i) => i.src === 'Engineering');
    expect(eng).toHaveLength(1);
    expect(eng[0]!.keys).toHaveLength(2);
  });
});

describe('units and batches', () => {
  it('never separates an answer from its question', () => {
    const items = consolidate(OCC);
    const units = unitsOf(items);
    const work = units.find((u) => u.ids.some((i) => items[i]!.src === 'Engineering'))!;
    expect(work.atomic).toBe(true);
    expect(work.ids.map((i) => items[i]!.src)).toEqual(['What best describes your work?', 'Engineering']);
    // Tiny batches: units still travel whole.
    const batches = batchUnits(items, units, 60, 3);
    const withEng = batches.find((b) => b.ids.some((i) => items[i]!.src === 'Engineering'))!;
    expect(withEng.ids.map((i) => items[i]!.src)).toContain('What best describes your work?');
  });

  it('splits an oversized unit with its label as read-only context, and retries keep the question', () => {
    const big = Array.from({ length: 10 }, (_, i) => occ(`Option ${i}`, { ...general, group: 'Language', groupRole: 'select', role: 'option' }, 'g:lang1'));
    const items = consolidate([occ('Language', { ...general, group: 'Language', groupRole: 'select', role: 'label' }, 'g:lang1'), ...big]);
    const batches = batchUnits(items, unitsOf(items), 1000, 4);
    expect(batches.length).toBe(3);
    for (const b of batches.slice(1)) expect(b.context?.map((i) => items[i]!.src)).toContain('Language');
    const retry = retryBatches(items, [5], 1000, 4);
    expect(retry).toHaveLength(1);
    expect(retry[0]!.ids).toEqual([5]);
    expect(retry[0]!.context!.map((i) => items[i]!.src)[0]).toBe('Language');
  });

  it('only approved strings may appear as structure labels', () => {
    const items = consolidate(OCC.filter((o) => o.src !== 'General'));
    const labels = approvedLabels(items, ['Settings']);
    expect(labels).toContain('Transcript width');
    expect(labels).toContain('Settings');
    expect(labels).not.toContain('General'); // section label not approved anywhere
  });
});

describe('prompt v2 outline', () => {
  it('renders hierarchy, role words and the group label as the group line', () => {
    const items = consolidate(OCC).filter((i) => i.where?.section === 'General' && i.src !== 'General');
    const text = buildOutline(items, [], new Set(['Settings']));
    expect(text).toBe([
      'dialog "Settings"',
      ' section',
      '  radios <1>Transcript text size</1>',
      '   opt <2>Small</2>',
      '   opt <3>Medium</3>',
      '  radios <4>Transcript width</4>',
      '   opt <5>Medium</5>',
      '   opt <6>Wide</6>',
    ].join('\n'));
  });

  it('shows read-only context quoted and never unapproved labels', () => {
    const items = consolidate(OCC);
    const eng = items.find((i) => i.src === 'Engineering')!;
    const q = items.find((i) => i.src === 'What best describes your work?')!;
    const msgs = buildUiBatchMessages({ targetLang: 'zh-CN', appName: 'App', host: 'app.example.com', description: '', glossary: [], items: [eng], context: [q], labels: new Set() });
    const user = msgs[1]!.content;
    expect(user).toContain('select "What best describes your work?"');
    expect(user).toContain('value <1>Engineering</1>');
    expect(user).not.toContain('Account'); // section label not approved
    expect(msgs[0]!.content).toContain('answer their group');
  });
});

describe('review rows', () => {
  it('counts a place-independent string once, and a string that needs its question once per place', () => {
    const close = (key: string) => ({ key, kind: 'aria-label' as const, src: 'Close', where: { section: key } });
    const medium = (key: string, group: string) => ({ key, kind: 'text' as const, src: 'Medium', ctx: `g:${key}`, where: { group, groupRole: 'radiogroup', role: 'radio' } });
    const rows = new Set([close('a'), close('b'), medium('c', 'Text size'), medium('d', 'Width')].map(reviewRowKey));
    expect(rows.size).toBe(3);
    // Seen before but in a new place: its own row, so it can be reviewed there.
    expect(reviewRowKey({ ...close('e'), newContext: true })).toBe('e');
  });
});
