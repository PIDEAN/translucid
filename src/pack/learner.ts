// Continued learning: UI strings the pack does not know yet, noticed while the
// user simply uses the site. Fed by the applier's misses, processed off the hot
// path, classified (content is never kept) and rate limited. Paused while an
// exploration scan runs. Nothing here talks to a model: candidates wait for
// review like any other.
import { normalizeKey, resolve, variantKey, type EntryKind, type PackRuntime } from './format';
import { classify } from './classify';
import { regionOf, toEntryWhere, type StructuredCandidate } from './harvest';
import { originalAttr, originalData, packRegistry } from './registry';
import { describe, signatures } from './structure';

export const LEARN_LIMITS = { perMinute: 60, perPage: 300, queue: 500, delayMs: 1000, retryMs: 5000 } as const;

const SURFACE_OR_LANDMARK =
  '[role="dialog"],[role="alertdialog"],dialog[open],[role="menu"],[role="listbox"],[role="tooltip"],[data-radix-popper-content-wrapper],nav,aside,header,[role="navigation"],[role="banner"],[role="complementary"],[role="toolbar"],[role="tablist"],[role="menubar"]';

/** Does `el` still show `src` (as the app wrote it)? Apps recycle nodes between queueing and processing. */
function stillShows(el: Element, kind: EntryKind, src: string): boolean {
  if (kind !== 'text') return normalizeKey(originalAttr(el, kind) ?? '') === src;
  for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE && normalizeKey(originalData(n)) === src) return true;
  return false;
}

export class Learner {
  private queue: [EntryKind, string, Element][] = [];
  /** Elements already queued per string: repeated misses of one node cost nothing. */
  private offered = new WeakMap<Element, Set<string>>();
  /** Distinct contexts learned per string (a string seen in many places is kept a few times). */
  private contexts = new Map<string, number>();
  private seen = new Set<string>();
  private stamps: number[] = [];
  private total = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private runtime: () => PackRuntime | undefined,
    private push: (c: StructuredCandidate) => void,
    private now: () => number = Date.now,
  ) {}

  get learned(): number {
    return this.total;
  }

  /** A miss reported by the applier (cheap: just queued). */
  offer(kind: EntryKind, src: string, el: Element): void {
    if (this.total >= LEARN_LIMITS.perPage || this.queue.length >= LEARN_LIMITS.queue) return;
    const k = kind + '\u0001' + src;
    if ((this.contexts.get(k) ?? 0) >= 8) return;
    const done = this.offered.get(el) ?? new Set<string>();
    if (done.has(k)) return;
    done.add(k);
    this.offered.set(el, done);
    this.queue.push([kind, src, el]);
    this.timer ??= setTimeout(() => this.process(), LEARN_LIMITS.delayMs);
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.queue = [];
  }

  process(): void {
    this.timer = undefined;
    const rt = this.runtime();
    if (!rt || packRegistry().scanning) {
      // Dropped unprocessed: the same nodes may be offered again later.
      for (const [kind, src, el] of this.queue) this.offered.get(el)?.delete(kind + '\u0001' + src);
      this.queue = [];
      return;
    }
    const now = this.now();
    this.stamps = this.stamps.filter((t) => now - t < 60_000);
    const auto = rt.scope === 'auto' && rt.learn === true;
    while (this.queue.length && this.total < LEARN_LIMITS.perPage && this.stamps.length < LEARN_LIMITS.perMinute) {
      const [kind, src, el] = this.queue.shift()!;
      // Recycled since it was queued (a name became "Settings"): the old text is not this place's.
      if (!el.isConnected || !stillShows(el, kind, src)) continue;
      const region = rt.regions.length ? regionOf(el, rt.regions) : undefined;
      // Approved regions only, unless the user enabled automatic learning.
      if (!region && !auto) continue;
      const verdict = classify(el, kind, src, rt.targetLang);
      if (!verdict || verdict.tier === 'content') continue;
      if (!region && verdict.tier !== 'high' && !el.closest(SURFACE_OR_LANDMARK)) continue;
      const where = describe(el, kind);
      const sigs = signatures(where);
      const key = variantKey(kind, src, sigs[0]);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      const base = kind + '\u0001' + src;
      this.contexts.set(base, (this.contexts.get(base) ?? 0) + 1);
      // Known here after all (a newer revision arrived): nothing to learn.
      if (typeof resolve(rt, kind, src, () => sigs) === 'string') continue;
      this.push({
        kind,
        src,
        region: region?.id ?? 'auto',
        flags: verdict.flags,
        tier: verdict.tier,
        ...(verdict.tier !== 'high' && verdict.reason ? { reason: verdict.reason } : {}),
        ...(sigs[0] ? { ctx: sigs[0] } : {}),
        where: toEntryWhere(where),
        source: region ? 'pick' : 'learn',
      });
      this.total++;
      this.stamps.push(now);
    }
    if (this.queue.length && this.total < LEARN_LIMITS.perPage) this.timer = setTimeout(() => this.process(), LEARN_LIMITS.retryMs);
  }
}
