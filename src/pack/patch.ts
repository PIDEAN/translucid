import type { SitePack } from './format';
import type { PackPatch } from './messages';

/** Apply a sites-page patch to the current pack (inside mutatePack; the result is validated there). */
export function applyPackPatch(pack: SitePack, p: PackPatch): SitePack {
  const next = structuredClone(pack);
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : undefined);
  if (typeof p.name === 'string') next.site.name = p.name;
  const hosts = strs(p.hosts)?.map((h) => h.toLowerCase());
  if (hosts) {
    const primary = pack.site.hosts[0]!;
    if (!hosts.includes(primary)) throw new Error(`主域名 ${primary} 不能删除（它决定语言包身份）`);
    next.site.hosts = [primary, ...hosts.filter((h) => h !== primary)];
  }
  const scopes = strs(p.scopes);
  if (scopes) next.site.scopes = scopes.length ? scopes : ['/'];
  if (typeof p.description === 'string') next.site.description = p.description;
  if (p.hydration === 'after-idle' || p.hydration === 'immediate') next.options.hydration = p.hydration;
  if (typeof p.learn === 'boolean') {
    next.options.learn = p.learn;
    // Learning beyond approved regions is automatic scope.
    if (p.learn) next.options.scope = 'auto';
  }
  if (p.scope === 'auto' || p.scope === 'regions') next.options.scope = p.scope;
  const keepRegions = strs(p.keepRegions);
  if (keepRegions) next.regions = pack.regions.filter((r) => keepRegions.includes(r.id));
  const keepExcludes = strs(p.keepExcludes);
  if (keepExcludes) next.excludes = pack.excludes.filter((x) => keepExcludes.includes(x));
  const removeRegions = strs(p.removeRegions);
  if (removeRegions) next.regions = next.regions.filter((r) => !removeRegions.includes(r.id));
  const removeExcludes = strs(p.removeExcludes);
  if (removeExcludes) next.excludes = next.excludes.filter((x) => !removeExcludes.includes(x));
  return next;
}


/** Only fields changed from this form's original snapshot are submitted. */
export function settingsDraftPatch(base: SitePack, draft: SitePack): PackPatch {
  const patch: PackPatch = {};
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (draft.site.name !== base.site.name) patch.name = draft.site.name;
  if (!same(draft.site.hosts, base.site.hosts)) patch.hosts = [...draft.site.hosts];
  if (!same(draft.site.scopes, base.site.scopes)) patch.scopes = [...draft.site.scopes];
  if (draft.site.description !== base.site.description) patch.description = draft.site.description;
  if (draft.options.hydration !== base.options.hydration) patch.hydration = draft.options.hydration;
  if (draft.options.scope !== base.options.scope) patch.scope = draft.options.scope;
  const removedRegions = base.regions.filter((r) => !draft.regions.some((x) => x.id === r.id)).map((r) => r.id);
  if (removedRegions.length) patch.removeRegions = removedRegions;
  const removedExcludes = base.excludes.filter((x) => !draft.excludes.includes(x));
  if (removedExcludes.length) patch.removeExcludes = removedExcludes;
  return patch;
}
