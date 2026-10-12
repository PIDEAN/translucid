import { describe, expect, it } from 'vitest';
import { emptyPack, type SitePack } from '../src/pack/format';
import { alreadyInTarget, hrefLooksPersonal, idLikeSegment, scrubForExport, textFlags } from '../src/pack/privacy';

describe('textFlags', () => {
  it('passes ordinary UI strings', () => {
    for (const s of ['New chat', 'Settings', 'Search chats', 'Upgrade plan', 'Log out', 'Share']) expect(textFlags(s, 'zh-CN')).toEqual([]);
  });
  it('flags personal and non-UI content', () => {
    expect(textFlags('mira.chen@example.org')).toContain('email');
    expect(textFlags('Visit https://example.org/x')).toContain('url');
    expect(textFlags('+1 (555) 010-2030')).toContain('phone');
    expect(textFlags('@kael_dev')).toContain('handle');
    expect(textFlags('1,234')).toContain('number');
    expect(textFlags('Oct 11, 2026')).toContain('date');
    expect(textFlags('14:05')).toContain('date');
    expect(textFlags('notes_final.txt')).toContain('identifier');
    expect(textFlags('This is a long message that a user typed into the chat window and it keeps going on')).toContain('long');
    expect(textFlags('Mira Chen, Kael Ortiz, Lena Park')).toContain('names');
    expect(textFlags('新建对话', 'zh-CN')).toContain('already-target');
    // Display names and initials in an account menu; common UI acronyms are fine.
    expect(textFlags('MIRACHEN')).toContain('possible-name');
    expect(textFlags('MC')).toContain('possible-name');
    expect(textFlags('FAQ')).toEqual([]);
    expect(textFlags('API')).toEqual([]);
  });
  it('detects strings already in CJK targets only', () => {
    expect(alreadyInTarget('設定', 'ja')).toBe(false); // kanji only: ambiguous, keep
    expect(alreadyInTarget('せってい', 'ja')).toBe(true);
    expect(alreadyInTarget('설정', 'ko')).toBe(true);
    expect(alreadyInTarget('Einstellungen', 'de')).toBe(false);
  });
});

describe('personal links', () => {
  it('recognizes ids in paths, queries and hash routes', () => {
    expect(idLikeSegment('3f2b8c1e-9a7d-4e21-b5c3-0d9e8f7a6b5c')).toBe(true);
    expect(idLikeSegment('a1b2c3')).toBe(true);
    expect(idLikeSegment('settings')).toBe(false);
    expect(idLikeSegment('v2')).toBe(false);
    expect(hrefLooksPersonal('/chat/3f2b8c1e-9a7d-4e21-b5c3-0d9e8f7a6b5c')).toBe(true);
    expect(hrefLooksPersonal('/c/a1b2c3')).toBe(true);
    expect(hrefLooksPersonal('/session?id=98765')).toBe(true);
    expect(hrefLooksPersonal('/#/doc/k3j4h5g6')).toBe(true);
    expect(hrefLooksPersonal('/settings/profile')).toBe(false);
    expect(hrefLooksPersonal('/new')).toBe(false);
  });
});

describe('scrubForExport', () => {
  it('removes flagged, stale and timestamped data and reports it', () => {
    const pack: SitePack = {
      ...emptyPack('app.example.com', 'zh-CN', 5),
      site: { hosts: ['app.example.com'], scopes: ['/'], name: 'App', description: 'Chat app. Contact mira.chen@example.org' },
      regions: [
        { id: 'r1', label: '侧栏', selector: 'nav[aria-label="Sidebar"]' },
        { id: 'r2', label: '个人', selector: 'div[aria-label="@kael_dev workspace"]' },
      ],
      glossary: [{ src: 'Project', tgt: '项目', note: 'see https://example.org/terms' }],
      entries: [
        { kind: 'text', src: 'New chat', t: '新建对话', status: 'auto', approvedAt: 1, lastSeen: 2 },
        { kind: 'text', src: 'mira.chen@example.org', t: 'mira.chen@example.org', status: 'edited' },
        { kind: 'text', src: 'Old thing', t: '旧的', status: 'stale' },
      ],
      generator: { model: 'm', promptVersion: 1, createdAt: 123, updatedAt: 456 },
    };
    const { pack: out, report } = scrubForExport(pack);
    expect(out.entries).toEqual([{ kind: 'text', src: 'New chat', t: '新建对话', status: 'auto' }]);
    expect(out.regions.map((r) => r.id)).toEqual(['r1']);
    expect(out.site.description).toBe('Chat app. Contact');
    expect(out.glossary[0]).toEqual({ src: 'Project', tgt: '项目', note: 'see' });
    expect(out.generator).toEqual({ model: 'm', promptVersion: 1, createdAt: 0, updatedAt: 0 });
    expect(report.removed.map((r) => r.what)).toEqual(
      expect.arrayContaining(['mira.chen@example.org', 'Old thing', '区域 个人', '术语备注：Project', '应用描述']),
    );
  });
});

describe('export scrub (v2 metadata)', () => {
  it('drops personal structure labels and flagged glossary terms', async () => {
    const { scrubForExport } = await import('../src/pack/privacy');
    const { emptyPack } = await import('../src/pack/format');
    const pack = {
      ...emptyPack('app.example.com', 'zh-CN'),
      entries: [
        { kind: 'text' as const, src: 'Medium', t: '中', ctx: 'g:abcd', status: 'auto' as const, where: { section: 'General', group: 'Transcript width', role: 'radio' } },
        { kind: 'text' as const, src: 'Rename', t: '重命名', status: 'auto' as const, where: { section: 'mira.chen@example.org', role: 'menuitem' } },
      ],
      glossary: [{ src: 'Projects', tgt: '项目' }, { src: 'mira.chen@example.org', tgt: 'x' }],
    };
    const { pack: out, report } = scrubForExport(pack);
    expect(out.entries[0]!.where).toEqual({ section: 'General', group: 'Transcript width', role: 'radio' });
    expect(out.entries[0]!.ctx).toBe('g:abcd');
    expect(out.entries[1]!.where).toBeUndefined();
    expect(out.glossary).toEqual([{ src: 'Projects', tgt: '项目' }]);
    expect(report.removed.length).toBe(2);
  });
});

describe('all exported metadata is contact-free', () => {
  it('scrubs names, descriptions, glossary notes and builtin region labels at validation and export', async () => {
    const { validatePack } = await import('../src/pack/format');
    const pack: SitePack = {
      ...emptyPack('app.example.com', 'zh-CN'),
      site: { hosts: ['app.example.com'], scopes: ['/'], name: 'App help@example.org', description: 'Call +1 (555) 010-2030 or @kael_dev' },
      regions: [{ id: 'overlays', builtin: 'overlays', label: 'Menu help@example.org +1 (555) 010-2030 @kael_dev' }],
      glossary: [{ src: 'Project', tgt: '项目', note: 'Call +1 (555) 010-2030 @kael_dev or https://example.org' }],
    };
    for (const out of [scrubForExport(pack).pack, validatePack(pack)]) {
      const json = JSON.stringify(out);
      for (const contact of ['help@example.org', '+1 (555) 010-2030', '@kael_dev', 'https://example.org']) expect(json).not.toContain(contact);
    }
  });
});

it('rejects contact-bearing scopes without widening them to / and drops contact-bearing structural identifiers', async () => {
  const { validatePack } = await import('../src/pack/format');
  const pack = emptyPack('app.example.com', 'zh-CN');
  for (const scope of ['/users/owner@example.org/', '/users/owner%40example.org/']) {
    const unsafe = { ...pack, site: { ...pack.site, scopes: [scope] } };
    expect(validatePack(unsafe)).toMatchObject({ ok: false });
    expect(() => scrubForExport(unsafe)).toThrow('路径范围含');
  }
  const unsafe = { ...pack, regions: [{ id: 'owner@example.org', label: '', selector: 'nav' }], entries: [{ kind: 'text' as const, src: 'Settings', t: '设置', region: 'owner@example.org', status: 'auto' as const }], surfaces: [{ key: 'owner@example.org', kind: 'menu' }] };
  const validated = validatePack(unsafe);
  expect(validated.ok).toBe(true);
  if (validated.ok) { expect(validated.pack.regions).toEqual([]); expect(validated.pack.entries).toEqual([]); expect(validated.pack.surfaces).toEqual([]); }
  expect(JSON.stringify(scrubForExport(unsafe).pack)).not.toContain('owner@example.org');
});
