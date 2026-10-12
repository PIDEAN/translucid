import type { Settings } from '../shared/types';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const identities: Record<string, string> = { providers: 'id', experts: 'id', siteRules: 'host' };

/** Three-way merge: local edits win conflicts, including removals of optional keys. */
function merge(base: unknown, local: unknown, latest: unknown, identity?: string): unknown {
  if (same(base, local)) return structuredClone(latest);
  if (identity && Array.isArray(base) && Array.isArray(local) && Array.isArray(latest)) {
    const key = (x: Record<string, unknown>) => identity === 'host' ? String(x.host).trim() : x[identity];
    const index = (xs: Record<string, unknown>[]) => new Map(xs.map((x) => [key(x), x]));
    const before = index(base), edits = index(local), external = index(latest);
    const out: unknown[] = [];
    for (const key of new Set([...external.keys(), ...edits.keys()])) {
      if (!edits.has(key)) {
        if (!before.has(key)) out.push(structuredClone(external.get(key)));
        continue;
      }
      if (!external.has(key) && same(edits.get(key), before.get(key))) continue;
      out.push(merge(before.get(key), edits.get(key), external.get(key)));
    }
    return out;
  }
  if (object(base) && object(local)) {
    if (!object(latest)) return structuredClone(local);
    const out = structuredClone(latest);
    for (const key of new Set([...Object.keys(base), ...Object.keys(local)])) {
      if (!Object.hasOwn(local, key)) { delete out[key]; continue; }
      if (!same(base[key], local[key])) out[key] = merge(base[key], local[key], out[key]);
    }
    return out;
  }
  return structuredClone(local);
}

export function mergeSettings(base: Settings, local: Settings, latest: Settings): Settings {
  const out = structuredClone(latest) as unknown as Record<string, unknown>;
  const before = base as unknown as Record<string, unknown>;
  const edits = local as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(before), ...Object.keys(edits)])) {
    if (!Object.hasOwn(edits, key)) { delete out[key]; continue; }
    out[key] = merge(before[key], edits[key], out[key], identities[key]);
  }
  return out as unknown as Settings;
}

/** Keep live form callback references attached while reconciling a successful save. */
export function syncSettingsDraft(current: Settings, next: Settings): void {
  for (const key of Object.keys(current)) if (!Object.hasOwn(next, key)) delete (current as unknown as Record<string, unknown>)[key];
  for (const [key, value] of Object.entries(next)) {
    const target = current as unknown as Record<string, unknown>;
    const identity = identities[key];
    if (identity && Array.isArray(target[key]) && Array.isArray(value)) {
      const itemKey = (x: Record<string, unknown>) => identity === 'host' ? String(x.host).trim() : x[identity];
      const items = new Map((target[key] as Record<string, unknown>[]).map((x) => [itemKey(x), x]));
      target[key] = value.map((item: Record<string, unknown>) => {
        const existing = items.get(itemKey(item));
        if (!existing) return structuredClone(item);
        for (const field of Object.keys(existing)) if (!Object.hasOwn(item, field)) delete existing[field];
        Object.assign(existing, structuredClone(item));
        return existing;
      });
    } else target[key] = structuredClone(value);
  }
}
