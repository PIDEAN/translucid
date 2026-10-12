// Candidate strings waiting for review, per pack. Local only, never exported,
// never sent anywhere without per-string approval. Entries expire after 30 days
// and the pool is capped; no routes, queries or hashes are kept. Items are keyed
// by string + context: the same word in two groups is two occurrences.
import { browser } from 'wxt/browser';
import { CTX_RE, ENTRY_KINDS, entryKey, hasMarkup, LIMITS, normalizeKey, sanitizeWhere, variantKey, type EntryKind, type EntryWhere, type SitePack } from '../pack/format';
import type { CandidateSource, StructuredCandidate } from '../pack/harvest';
import { isHardFlagged, textFlags, type PrivacyFlag } from '../pack/privacy';

export interface PendingItem {
  kind: EntryKind;
  src: string;
  region: string;
  flags: PrivacyFlag[];
  count: number;
  firstSeen: number;
  lastSeen: number;
  ctx?: string;
  where?: EntryWhere;
  /** high: checked by default; uncertain: unchecked, with a reason. Missing on v1 items. */
  tier?: 'high' | 'uncertain';
  reason?: string;
  source?: CandidateSource;
  /** The string is already translated elsewhere, but only for other contexts. */
  newContext?: boolean;
  /** Collection order (browser storage returns object keys sorted, not in insertion order). */
  seq?: number;
}

const bySeq = (a: PendingItem, b: PendingItem) => (a.seq ?? a.firstSeen) - (b.seq ?? b.firstSeen);

/** Storage key of an item (string + context). */
export const pendingKey = (p: { kind: EntryKind; src: string; ctx?: string }) => variantKey(p.kind, p.src, p.ctx);
export const tierOf = (p: PendingItem): 'high' | 'uncertain' => (p.flags.length ? 'uncertain' : (p.tier ?? 'high'));

type PendingStore = Record<string, PendingItem>;

export const PENDING_TTL_MS = 30 * 86_400_000;
export const PENDING_CAP = 8000;
const key = (id: string) => `pending:${id}`;
const ignoreKey = (id: string) => `pendingIgnore:${id}`;
const IGNORE_CAP = 5000;

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

async function read(id: string): Promise<PendingStore> {
  return ((await browser.storage.local.get(key(id)))[key(id)] as PendingStore | undefined) ?? {};
}

/** Drop expired items and keep the most recently seen ones under the cap. */
export function prune(store: PendingStore, now: number): PendingStore {
  const fresh = Object.entries(store).filter(([, v]) => now - v.lastSeen < PENDING_TTL_MS);
  fresh.sort((a, b) => b[1].lastSeen - a[1].lastSeen);
  return Object.fromEntries(fresh.slice(0, PENDING_CAP));
}

const SOURCES: readonly CandidateSource[] = ['pick', 'scan', 'learn'];

/** Labels stored with an item must not look personal either (defense in depth on top of structure.clean). */
function safeWhere(raw: unknown): EntryWhere | undefined {
  const w = sanitizeWhere(raw);
  if (!w) return undefined;
  for (const f of ['surface', 'section', 'group'] as const) {
    const v = w[f];
    if (v && textFlags(v.replace(/^\w+: /, '')).some((x) => x !== 'identifier')) delete w[f];
  }
  return w;
}

/**
 * Sanitize candidates from a content script: known kinds, bounded length, a
 * region the pack actually has (or 'auto' for automatic scope), flags
 * recomputed here (page-sent flags are only trusted when they add caution, like
 * `personal-link`), structure metadata validated, tier never above what the
 * flags allow.
 */
export function sanitizeCandidates(pack: SitePack, list: unknown): StructuredCandidate[] {
  if (!Array.isArray(list)) return [];
  const regions = new Set(pack.regions.map((r) => r.id));
  if (pack.options.scope === 'auto') regions.add('auto');
  const out: StructuredCandidate[] = [];
  for (const c of list.slice(0, 2000)) {
    const kind = c?.kind as EntryKind;
    if (!ENTRY_KINDS.includes(kind) || typeof c.src !== 'string' || typeof c.region !== 'string') continue;
    const src = normalizeKey(c.src);
    if (!src || src.length > LIMITS.keyChars * 2 || !regions.has(c.region)) continue;
    const flags = textFlags(src, pack.targetLang);
    if (Array.isArray(c.flags) && c.flags.includes('personal-link')) flags.push('personal-link');
    if (isHardFlagged(flags) || flags.includes('no-letters') || flags.includes('already-target')) continue;
    const item: StructuredCandidate = { kind, src, region: c.region, flags, tier: !flags.length && c.tier === 'high' ? 'high' : 'uncertain' };
    if (typeof c.ctx === 'string' && CTX_RE.test(c.ctx)) item.ctx = c.ctx;
    const where = safeWhere(c.where);
    if (where) item.where = where;
    if (typeof c.reason === 'string' && c.reason.length <= 60 && !hasMarkup(c.reason)) item.reason = c.reason;
    if (SOURCES.includes(c.source)) item.source = c.source;
    out.push(item);
  }
  return out;
}

/**
 * Is this occurrence new to the pack? 'known' (an entry already covers it),
 * 'new-context' (the string has only context variants, none for this place),
 * or 'new'.
 */
export function knownState(pack: SitePack, kind: EntryKind, src: string, ctx?: string): 'known' | 'new-context' | 'new' {
  const base = entryKey(kind, src);
  let variants = 0;
  for (const e of pack.entries) {
    if (entryKey(e.kind, e.src) !== base) continue;
    if (!e.ctx || e.ctx === ctx) return 'known';
    variants++;
  }
  return variants ? (ctx ? 'new-context' : 'known') : 'new';
}

/** Strings the user said never to collect again (every context). */
async function ignored(id: string): Promise<Set<string>> {
  return new Set(((await browser.storage.local.get(ignoreKey(id)))[ignoreKey(id)] as string[] | undefined) ?? []);
}

/** Remove these occurrences and never collect their strings again. */
export function ignorePending(id: string, keys: string[]): Promise<void> {
  return serial(async () => {
    const store = await read(id);
    const bases = new Set<string>();
    for (const k of keys) {
      const v = store[k];
      if (v) bases.add(entryKey(v.kind, v.src));
    }
    for (const [k, v] of Object.entries(store)) if (bases.has(entryKey(v.kind, v.src))) delete store[k];
    const list = [...new Set([...(await ignored(id)), ...bases])].slice(-IGNORE_CAP);
    await browser.storage.local.set({ [key(id)]: store, [ignoreKey(id)]: list });
  });
}

export async function clearIgnored(id: string): Promise<void> {
  await browser.storage.local.remove(ignoreKey(id));
}

export function addCandidates(pack: SitePack, candidates: StructuredCandidate[], now = Date.now()): Promise<number> {
  return serial(async () => {
    const store = await read(pack.id);
    const skip = await ignored(pack.id);
    let seq = Object.values(store).reduce((m, v) => Math.max(m, v.seq ?? 0), 0);
    const perBase = new Map<string, number>();
    for (const v of Object.values(store)) perBase.set(entryKey(v.kind, v.src), (perBase.get(entryKey(v.kind, v.src)) ?? 0) + 1);
    let added = 0;
    for (const c of candidates) {
      if (skip.has(entryKey(c.kind, c.src))) continue;
      const state = knownState(pack, c.kind, c.src, c.ctx);
      if (state === 'known') continue;
      const k = pendingKey(c);
      const prev = store[k];
      if (prev) {
        prev.count++;
        prev.lastSeen = now;
        prev.flags = [...new Set([...prev.flags, ...c.flags])];
        if (c.tier === 'uncertain') prev.tier = 'uncertain';
        continue;
      }
      // Bounded occurrences per string: a word repeated in many places is reviewed a few times, not hundreds.
      const base = entryKey(c.kind, c.src);
      const n = perBase.get(base) ?? 0;
      if (n >= LIMITS.contextsPerKey) continue;
      perBase.set(base, n + 1);
      store[k] = {
        kind: c.kind,
        src: c.src,
        region: c.region,
        flags: c.flags,
        count: 1,
        firstSeen: now,
        lastSeen: now,
        seq: ++seq,
        tier: c.tier,
        ...(c.ctx ? { ctx: c.ctx } : {}),
        ...(c.where ? { where: c.where } : {}),
        ...(c.reason ? { reason: c.reason } : {}),
        ...(c.source ? { source: c.source } : {}),
        ...(state === 'new-context' ? { newContext: true } : {}),
      };
      added++;
    }
    await browser.storage.local.set({ [key(pack.id)]: prune(store, now) });
    return added;
  });
}

/**
 * Pending items with flags recomputed under the current rules; anything now
 * hard-flagged is deleted from storage (older collections are cleaned up too).
 */
export function getPending(id: string, now = Date.now()): Promise<PendingItem[]> {
  return serial(async () => {
    const lang = id.split('~')[1] ?? '';
    const raw = await read(id);
    const store = prune(raw, now);
    // Expired items are deleted, not just hidden.
    let dropped = Object.keys(store).length !== Object.keys(raw).length;
    for (const [k, v] of Object.entries(store)) {
      const flags = [...new Set([...textFlags(v.src, lang), ...v.flags.filter((f) => f === 'personal-link')])];
      if (isHardFlagged(flags)) {
        delete store[k];
        dropped = true;
      } else v.flags = flags;
    }
    if (dropped) await browser.storage.local.set({ [key(id)]: store });
    return Object.values(store).sort(bySeq);
  });
}

/** Remove strings (every context) that sit in areas the user just marked as content (excludes are retroactive). */
export function dropPending(id: string, baseKeys: string[]): Promise<void> {
  return serial(async () => {
    const drop = new Set(baseKeys);
    const store = await read(id);
    for (const [k, v] of Object.entries(store)) if (drop.has(entryKey(v.kind, v.src))) delete store[k];
    await browser.storage.local.set({ [key(id)]: store });
  });
}

/** Remove reviewed items (or everything when `keys` is omitted). */
export function clearPending(id: string, keys?: string[]): Promise<void> {
  return serial(async () => {
    if (!keys) {
      await browser.storage.local.remove(key(id));
      return;
    }
    const store = await read(id);
    for (const k of keys) delete store[k];
    await browser.storage.local.set({ [key(id)]: store });
  });
}
