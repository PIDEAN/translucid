// Turns approved occurrences into translation items, question units and
// batches. Pure functions, shared by the preview and the generation job so the
// preview is exactly what is sent.
//
// - Occurrences whose meaning depends on their group (options, radio choices,
//   dropdown values) keep one item per context; everything else is translated
//   once per string and applied wherever it appears.
// - A unit is a whole question: group label, description, value and options.
//   Units are never split across batches unless one alone is too big, and then
//   every part carries the group label and siblings as read-only context.
import type { EntryKind, EntryWhere } from './format';

export interface Occurrence {
  /** Pending key (string + context). */
  key: string;
  kind: EntryKind;
  src: string;
  region: string;
  area: string;
  ctx?: string;
  where?: EntryWhere;
}

export interface PlanItem {
  kind: EntryKind;
  src: string;
  region: string;
  area: string;
  /** Present when this translation is for one context only. */
  ctx?: string;
  where?: EntryWhere;
  /** Every context this translation covers (recorded as context membership). */
  members?: string[];
  /** Pending keys this item answers (cleared on commit). */
  keys?: string[];
}

export interface PlanBatch {
  ids: number[];
  /** Read-only neighbours shown for context (same unit). */
  context?: number[];
}

const CONTEXT_ROLES = new Set(['option', 'radio', 'value', 'menuitem', 'checkbox', 'switch']);
const CHOICE_GROUPS = new Set(['radiogroup', 'select', 'listbox']);

/** Does this occurrence's translation depend on the group it answers? */
export function needsContext(o: Pick<Occurrence, 'ctx' | 'where'>): boolean {
  if (!o.ctx?.startsWith('g:') || !o.where?.group) return false;
  return CONTEXT_ROLES.has(o.where.role ?? '') || CHOICE_GROUPS.has(o.where.groupRole ?? '');
}

const baseKey = (o: { kind: EntryKind; src: string }) => o.kind + '\u0001' + o.src;

/**
 * One row of the review list: a string whose translation does not depend on its place ("Close" in
 * every section) is one row however often it appears; a string that needs its context, or showed up
 * in a new one, is a row per place. Counts shown to the user ("N 条") are rows.
 */
export function reviewRowKey(o: Pick<Occurrence, 'ctx' | 'where'> & { key: string; kind: string; src: string; newContext?: boolean }): string {
  return needsContext(o) || o.newContext ? o.key : `${o.kind}\u0001${o.src}`;
}

/** Merge occurrences into items, in page order (order of each item's first occurrence). */
export function consolidate(occurrences: Occurrence[]): PlanItem[] {
  const byBase = new Map<string, Occurrence[]>();
  const pos = new Map<Occurrence, number>(occurrences.map((o, i) => [o, i]));
  for (const o of occurrences) (byBase.get(baseKey(o)) ?? byBase.set(baseKey(o), []).get(baseKey(o))!).push(o);
  const out: (PlanItem & { at: number })[] = [];
  for (const list of byBase.values()) {
    // The same word answering two different questions: every grouped occurrence needs its context.
    const groups = new Set(list.filter((o) => o.ctx?.startsWith('g:')).map((o) => o.ctx));
    const sensitive = (o: Occurrence) => needsContext(o) || (groups.size > 1 && !!o.ctx?.startsWith('g:'));
    const shared = list.filter((o) => !sensitive(o));
    if (shared.length) {
      const first = shared[0]!;
      const members = [...new Set(shared.map((o) => o.ctx).filter((c): c is string => !!c))];
      // Seen in several sections (dialog chrome, nav items): it belongs to none of them.
      let where = first.where;
      if (where?.section && shared.some((o) => o.where?.section !== where!.section)) {
        const { section: _s, ...rest } = where;
        where = rest;
      }
      out.push({
        at: pos.get(first)!,
        kind: first.kind,
        src: first.src,
        region: first.region,
        area: first.area,
        ...(where ? { where } : {}),
        ...(members.length ? { members } : {}),
        keys: shared.map((o) => o.key),
      });
    }
    const byCtx = new Map<string, Occurrence[]>();
    for (const o of list) if (sensitive(o)) (byCtx.get(o.ctx!) ?? byCtx.set(o.ctx!, []).get(o.ctx!)!).push(o);
    for (const [ctx, same] of byCtx) {
      const first = same[0]!;
      out.push({
        at: pos.get(first)!,
        kind: first.kind,
        src: first.src,
        region: first.region,
        area: first.area,
        ctx,
        ...(first.where ? { where: first.where } : {}),
        members: [ctx],
        keys: same.map((o) => o.key),
      });
    }
  }
  return out.sort((a, b) => a.at - b.at).map(({ at: _at, ...it }) => it);
}

/** Store a batch in outline display order (ids then read top to bottom in the prompt). */
export function displayOrdered(items: PlanItem[], batch: PlanBatch, order: (list: PlanItem[]) => number[]): PlanBatch {
  const perm = order(batch.ids.map((i) => items[i]!));
  return { ...batch, ids: perm.map((k) => batch.ids[k]!) };
}

/**
 * Unit key: a labelled group is one question, wherever its parts render (the question and current
 * value in the dialog, the options in a portalled listbox share one `g:` context); ungrouped strings
 * group by screen and section (splittable).
 */
function unitKey(it: PlanItem): { key: string; atomic: boolean } {
  const g = [it.ctx, ...(it.members ?? [])].find((c) => c?.startsWith('g:'));
  if (g) return { key: g, atomic: true };
  const w = it.where;
  if (!w) return { key: `area\u0001${it.area}`, atomic: false };
  if (w.groupRole) return { key: [w.section, w.groupRole, w.group].join('\u0001'), atomic: true };
  return { key: [w.surface, w.section].join('\u0001'), atomic: false };
}

export interface Unit {
  ids: number[];
  atomic: boolean;
}

/** Group item indexes into units, in first-seen order. */
export function unitsOf(items: PlanItem[]): Unit[] {
  const map = new Map<string, Unit>();
  items.forEach((it, i) => {
    const { key, atomic } = unitKey(it);
    const u = map.get(key) ?? map.set(key, { ids: [], atomic }).get(key)!;
    u.ids.push(i);
  });
  return [...map.values()];
}

/** Read-only context for a part of a split unit: its group label first, then siblings. */
function contextFor(items: PlanItem[], unit: number[], part: number[], max = 12): number[] {
  const inPart = new Set(part);
  const rest = unit.filter((i) => !inPart.has(i));
  const label = rest.filter((i) => items[i]!.where?.role === 'label' || items[i]!.where?.role === 'legend');
  return [...label, ...rest.filter((i) => !label.includes(i))].slice(0, max);
}

/**
 * Pack units into batches of at most `maxChars` source characters and
 * `maxItems` strings. Atomic units stay together; an oversized one is split and
 * every part carries read-only context.
 */
export function batchUnits(items: PlanItem[], units: Unit[], maxChars: number, maxItems: number): PlanBatch[] {
  const len = (ids: number[]) => ids.reduce((n, i) => n + items[i]!.src.length, 0);
  const batches: PlanBatch[] = [];
  let cur: number[] = [];
  const flush = () => {
    if (cur.length) batches.push({ ids: cur });
    cur = [];
  };
  const sectionOf = (i: number) => `${items[i]!.where?.surface ?? items[i]!.area}\u0001${items[i]!.where?.section ?? ''}`;
  for (const u of units) {
    const fits = (ids: number[]) => cur.length + ids.length <= maxItems && len(cur) + len(ids) <= maxChars;
    // A new section starts a new request once the current one is mostly full: requests then hold
    // whole sections, and the model sees each section's strings together.
    if (cur.length && sectionOf(u.ids[0]!) !== sectionOf(cur.at(-1)!) && (cur.length >= maxItems * 0.6 || len(cur) >= maxChars * 0.6)) flush();
    if (fits(u.ids)) {
      cur.push(...u.ids);
      continue;
    }
    if (u.atomic && u.ids.length <= maxItems && len(u.ids) <= maxChars) {
      flush();
      cur.push(...u.ids);
      continue;
    }
    // Splittable (or too big): fill the current batch, then continue in new ones.
    let part: number[] = [];
    const parts: number[][] = [];
    for (const i of u.ids) {
      if (part.length && (part.length >= maxItems || len(part) + items[i]!.src.length > maxChars)) {
        parts.push(part);
        part = [];
      }
      part.push(i);
    }
    if (part.length) parts.push(part);
    if (!u.atomic) {
      for (const p of parts) {
        for (const i of p) {
          if (!fits([i])) flush();
          cur.push(i);
        }
      }
      continue;
    }
    flush();
    for (const p of parts) batches.push({ ids: p, context: contextFor(items, u.ids, p) });
  }
  flush();
  return batches;
}

/**
 * Retry batches for strings that came back missing or invalid: grouped by
 * unit, each with the rest of its unit as read-only context (never an orphan
 * "Engineering" without its question).
 */
export function retryBatches(items: PlanItem[], missing: number[], maxChars: number, maxItems: number): PlanBatch[] {
  const units = unitsOf(items);
  const miss = new Set(missing);
  const out: PlanBatch[] = [];
  for (const u of units) {
    const ids = u.ids.filter((i) => miss.has(i));
    if (!ids.length) continue;
    const sub = batchUnits(items, [{ ids, atomic: true }], maxChars, maxItems);
    for (const b of sub) out.push({ ids: b.ids, context: contextFor(items, u.ids, b.ids) });
  }
  return out;
}

/** Labels that may appear as context: structure labels that are approved strings (this plan or the pack). */
export function approvedLabels(items: PlanItem[], packSources: Iterable<string>): string[] {
  const approved = new Set([...packSources, ...items.map((i) => i.src)]);
  const used = new Set<string>();
  for (const it of items) {
    const w = it.where;
    if (!w) continue;
    const surface = w.surface?.split(': ').slice(1).join(': ');
    for (const l of [surface, w.section, w.group]) if (l && approved.has(l)) used.add(l);
  }
  return [...used];
}
