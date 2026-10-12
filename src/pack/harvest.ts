// Collects UI strings with their place in the interface. With scope 'regions'
// only user-approved regions are read; with 'auto' the classifier decides what
// is interface. User content is never kept (only counted); strings that might
// be personal carry flags, so the review screen shows them unchecked with the
// reason. Nothing here talks to a model.
import { ATTR_KINDS, normalizeKey, variantKey, type EntryKind, type EntryWhere, type PackRegion, type ScopeMode } from './format';
import { blockedForApply, skipSubtree, type ElementRules } from './dom-rules';
import { FLAG_LABELS, type PrivacyFlag } from './privacy';
import { originalAttr, originalData, packRegistry } from './registry';
import { classify, type Tier } from './classify';
import { describe, signatures, type Where } from './structure';

/** Menus, dialogs, tooltips and listboxes, which apps often portal to <body>. */
export const OVERLAY_SELECTOR = [
  '[role="menu"]', '[role="menubar"]', '[role="listbox"]', '[role="dialog"]', '[role="alertdialog"]', '[role="tooltip"]',
  'dialog[open]', '[data-radix-popper-content-wrapper]',
].join(',');

export interface Candidate {
  kind: EntryKind;
  src: string;
  region: string;
  flags: PrivacyFlag[];
}

export interface HarvestOptions {
  targetLang: string;
  /** Pack excludes joined into one selector (areas the user marked as content). */
  exclude: string;
}

const isButtonInput = (el: Element) =>
  el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(((el as HTMLInputElement).type || '').toLowerCase());

/** Root elements of a region in this document (a selector may match a few). */
export function regionRoots(doc: Document, region: PackRegion): Element[] {
  try {
    return [...doc.querySelectorAll(region.builtin === 'overlays' ? OVERLAY_SELECTOR : region.selector!)];
  } catch {
    return [];
  }
}

/** The approved region `el` belongs to, if any (first match wins). */
export function regionOf(el: Element, regions: PackRegion[]): PackRegion | undefined {
  for (const r of regions) {
    try {
      if (el.closest(r.builtin === 'overlays' ? OVERLAY_SELECTOR : r.selector!)) return r;
    } catch {
      /* invalid selector: region ignored */
    }
  }
  return undefined;
}

/**
 * Every string inside the given selectors, flags ignored: used to drop pending
 * candidates when the user marks an area as content after it was collected.
 */
export function stringsIn(doc: Document, selectors: string[]): { kind: EntryKind; src: string }[] {
  const out = new Map<string, { kind: EntryKind; src: string }>();
  const add = (kind: EntryKind, raw: string) => {
    const src = normalizeKey(raw);
    if (src) out.set(`${kind}\u0001${src}`, { kind, src });
  };
  for (const sel of selectors) {
    let roots: Element[] = [];
    try {
      roots = [...doc.querySelectorAll(sel)];
    } catch {
      continue;
    }
    for (const root of roots) {
      const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      for (let n: Node | null = root; n; n = walker.nextNode()) {
        if (n.nodeType === Node.TEXT_NODE) add('text', (n as Text).data);
        else for (const attr of [...ATTR_KINDS, 'value'] as EntryKind[]) {
          const v = (n as Element).getAttribute(attr);
          if (v) add(attr, v);
        }
      }
    }
  }
  return [...out.values()];
}

export const flagText = (flags: PrivacyFlag[]) => flags.map((f) => FLAG_LABELS[f]).join('、');

// ---------- structured collection (v2) ----------

export type CandidateSource = 'pick' | 'scan' | 'learn';

/** One occurrence of a UI string with its place in the interface. */
export interface StructuredCandidate extends Candidate {
  /** Context signature (structure.signatures, most specific). */
  ctx?: string;
  where?: EntryWhere;
  tier: Exclude<Tier, 'content'>;
  reason?: string;
  source?: CandidateSource;
}

export interface CollectOptions extends HarvestOptions {
  scope: ScopeMode;
  /** Approved regions: the only area for scope 'regions', forced includes for 'auto'. */
  regions: PackRegion[];
  /** Subtrees to read (scope 'auto'); defaults to the whole body. */
  roots?: (Element | ShadowRoot)[];
  /** Read already-translated nodes too, from their originals (scans of a translated page). */
  includeOwned?: boolean;
  /** Stop after this many occurrences (rate limits). */
  limit?: number;
  /**
   * Strings classified as content so far in this scan (shared across passes): none of them may
   * become a structure label of another string, even one collected in a later pass (a popup).
   */
  contentSeen?: Set<string>;
}

export interface CollectResult {
  candidates: StructuredCandidate[];
  /** Occurrences classified as user content: counted, never kept. */
  content: number;
}

/** Structure labels for storage: source-language labels only, already filtered by structure.clean. */
export function toEntryWhere(w: Where): EntryWhere {
  const out: EntryWhere = { role: w.role };
  out.surface = w.surface.label ? `${w.surface.kind}: ${w.surface.label}` : w.surface.kind;
  if (w.section) out.section = w.section;
  if (w.group?.label) out.group = w.group.label;
  if (w.group) out.groupRole = w.group.role;
  return out;
}

/**
 * Collect UI strings with structure. Each occurrence is classified (content is
 * only counted), described (surface › section › group, role) and tagged with
 * its context signature. Duplicates are merged per string and context.
 */
export function collect(doc: Document, opts: CollectOptions): CollectResult {
  const rules: ElementRules = { exclude: opts.exclude };
  const reg = packRegistry();
  const out = new Map<string, StructuredCandidate>();
  let content = 0;
  const contentSrcs = opts.contentSeen ?? new Set<string>();
  const limit = opts.limit ?? Infinity;
  const add = (kind: EntryKind, raw: string, el: Element, forced: PackRegion | undefined) => {
    if (out.size >= limit) return;
    const src = normalizeKey(raw);
    if (!src) return;
    const verdict = classify(el, kind, src, opts.targetLang);
    if (!verdict) return;
    if (verdict.tier === 'content') {
      content++;
      contentSrcs.add(src);
      return;
    }
    const where = describe(el, kind);
    const ctx = signatures(where)[0];
    const key = variantKey(kind, src, ctx);
    if (out.has(key)) return;
    // Inside a region the user picked, plain page text counts as interface.
    const tier = forced && verdict.reason === '页面中的普通文字' ? 'high' : verdict.tier;
    out.set(key, {
      kind,
      src,
      region: forced?.id ?? 'auto',
      flags: verdict.flags,
      tier,
      ...(tier !== 'high' && verdict.reason ? { reason: verdict.reason } : {}),
      ...(ctx ? { ctx } : {}),
      where: toEntryWhere(where),
    });
  };
  const regionFor = (el: Element) => (opts.regions.length ? regionOf(el, opts.regions) : undefined);

  const walk = (root: Element | ShadowRoot, region: PackRegion | undefined) => {
    const start = root.nodeType === Node.ELEMENT_NODE ? (root as Element) : null;
    if (start && skipSubtree(start, rules)) return;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.nodeType === Node.ELEMENT_NODE && skipSubtree(n as Element, rules) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    for (let n: Node | null = start ?? walker.nextNode(); n && out.size < limit; n = walker.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) {
        const parent = (n as Text).parentElement;
        const owned = reg.ownedText.has(n);
        if (!parent || (owned && !opts.includeOwned)) continue;
        const text = owned ? originalData(n) : (n as Text).data;
        if (!text.trim() || blockedForApply(parent)) continue;
        add('text', text, parent, region ?? regionFor(parent));
        continue;
      }
      const el = n as Element;
      const owned = reg.ownedAttr.has(el);
      if ((!owned || opts.includeOwned) && !blockedForApply(el)) {
        const forced = region ?? regionFor(el);
        for (const attr of ATTR_KINDS) {
          const v = owned ? originalAttr(el, attr) : el.getAttribute(attr);
          if (v?.trim()) add(attr, v, el, forced);
        }
        if (isButtonInput(el)) {
          const v = owned ? originalAttr(el, 'value') : el.getAttribute('value');
          if (v?.trim()) add('value', v, el, forced);
        }
      }
      const shadow = (el as HTMLElement).shadowRoot;
      if (shadow) walk(shadow, region);
    }
  };

  if (opts.scope === 'regions') {
    for (const region of opts.regions) for (const root of regionRoots(doc, region)) walk(root, region);
  } else {
    for (const root of opts.roots ?? (doc.body ? [doc.body] : [])) walk(root, undefined);
  }
  // A structure label that is someone's content in this very page (a card title used as a section
  // heading) is dropped from every candidate's place.
  const candidates = [...out.values()];
  if (contentSrcs.size) {
    for (const c of candidates) {
      if (c.where?.section && contentSrcs.has(c.where.section)) delete c.where.section;
      if (c.where?.group && contentSrcs.has(c.where.group)) delete c.where.group;
    }
  }
  return { candidates, content };
}
