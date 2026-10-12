import { describe, expect, it } from 'vitest';
import type { Settings } from '../src/shared/types';
import { DEFAULT_SETTINGS } from '../src/shared/settings';
import { mergeSettings, syncSettingsDraft } from '../src/ui/settings-merge';
import { emptyPack } from '../src/pack/format';
import { applyPackPatch, settingsDraftPatch } from '../src/pack/patch';

const baseSettings = (): Settings => ({ ...structuredClone(DEFAULT_SETTINGS), siteRules: [{ host: 'example.org', mode: 'default' as const }], providers: structuredClone(DEFAULT_SETTINGS.providers.slice(0, 2)) });

describe('three-way settings merges', () => {
  it('merges independent array items and fields, including detectedRegion and optional nested deletions', () => {
    const base = baseSettings();
    base.providers[0]!.price = { input: 1, output: 2 };
    const local = structuredClone(base), latest = structuredClone(base);
    local.providers[0]!.name = 'Edited';
    delete local.providers[0]!.price!.output;
    latest.providers[0]!.detectedRegion = 'global';
    latest.providers[0]!.price!.input = 3;
    latest.providers[1]!.apiKey = 'external-key';
    latest.siteRules[0]!.mode = 'always';
    local.siteRules.push({ host: 'local.org', mode: 'never' });
    const out = mergeSettings(base, local, latest);
    expect(out.providers[0]).toMatchObject({ name: 'Edited', detectedRegion: 'global', price: { input: 3 } });
    expect(out.providers[0]!.price).not.toHaveProperty('output');
    expect(out.providers[1]!.apiKey).toBe('external-key');
    expect(out.siteRules).toEqual([{ host: 'example.org', mode: 'always' }, { host: 'local.org', mode: 'never' }]);
  });

  it('honors local deletions/additions, remote deletions, and local edits conflicting with remote deletion', () => {
    const base = baseSettings(), local = structuredClone(base), latest = structuredClone(base);
    local.providers[0]!.apiKey = 'local-key';
    local.providers.splice(1, 1);
    latest.providers.splice(0, 1);
    latest.providers.push({ ...base.providers[0]!, id: 'remote', name: 'Remote' });
    const out = mergeSettings(base, local, latest);
    expect(out.providers.map((p) => p.id)).toEqual(['remote', base.providers[0]!.id]);
    expect(out.providers[1]).toEqual({ ...base.providers[0]!, apiKey: 'local-key' });
    expect(mergeSettings(base, base, latest).providers).toEqual(latest.providers);
  });

  it('preserves complete nested objects when the remote side deletes them and local wins the conflict', () => {
    const base = baseSettings();
    base.providers[0]!.price = { input: 1, output: 2 };
    const local = structuredClone(base), latest = structuredClone(base);
    local.providers[0]!.price!.input = 3;
    delete latest.providers[0]!.price;
    expect(mergeSettings(base, local, latest).providers[0]!.price).toEqual({ input: 3, output: 2 });
  });

  it('normalizes site-rule identity and keeps live provider callbacks attached during reconciliation', () => {
    const local = baseSettings();
    local.siteRules[0]!.host = 'example.org ';
    const written = structuredClone(local);
    written.siteRules[0]!.host = 'example.org';
    const live = structuredClone(local);
    live.siteRules[0]!.mode = 'never';
    const provider = live.providers[0]!;
    const out = mergeSettings(local, live, written);
    expect(out.siteRules).toEqual([{ host: 'example.org', mode: 'never' }]);
    syncSettingsDraft(live, out);
    expect(live.providers[0]).toBe(provider);
    provider.apiKey = 'still-attached';
    expect(live.providers[0]!.apiKey).toBe('still-attached');
  });
});

describe('site settings patches', () => {
  it('sends only local edits relative to the original form and deletes only explicitly removed old items', () => {
    const base = emptyPack('app.example.com', 'ja');
    base.regions = [{ id: 'old', label: 'Old', selector: 'nav' }];
    base.excludes = ['.old'];
    const draft = structuredClone(base);
    draft.site.name = 'Local name';
    draft.regions = [];
    draft.excludes = [];
    const latest = structuredClone(base);
    latest.site.description = 'External description';
    latest.regions.push({ id: 'new', label: 'New', selector: 'aside' });
    latest.excludes.push('.new');
    const patch = settingsDraftPatch(base, draft);
    expect(patch).toEqual({ name: 'Local name', removeRegions: ['old'], removeExcludes: ['.old'] });
    const saved = applyPackPatch(latest, patch);
    expect(saved.site.description).toBe('External description');
    expect(saved.regions.map((r) => r.id)).toEqual(['new']);
    expect(saved.excludes).toEqual(['.new']);
  });
});
