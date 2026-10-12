// Applies a site language pack in place: only `Text.data` and existing
// attributes change, nothing is moved, inserted or removed, so framework-owned
// DOM (React, Vue, Svelte, Angular) stays consistent. Every change is recorded
// with its original so `restore()` can undo exactly what is still ours, and the
// originals are published in the shared registry so structure analysis keeps
// reading the page in its source language.
//
// Strings whose translation depends on where they appear ("Medium" text size vs
// "Medium" width) resolve through context signatures. Those nodes are re-checked
// when their surroundings change, because apps recycle nodes: the same text node
// can move to another group without its text changing.
import { ATTR_KINDS, hasVariants, normalizeKey, resolve, type EntryKind, type PackRuntime } from './format';
import { blockedForApply, joinSelectors, skipFromAncestors, skipSubtree, type ElementRules } from './dom-rules';
import { notifyOwnership, packRegistry } from './registry';
import { contextAnchors, describe, signatures } from './structure';
import { contentAt } from './classify';

const ATTRS: readonly string[] = [...ATTR_KINDS, 'value'];
/** Attributes that change a string's context, not its text. */
const STRUCTURE_ATTRS = ['aria-labelledby', 'aria-describedby', 'aria-current', 'aria-selected', 'aria-expanded', 'data-state', 'role'];
const BOUNDARY_ATTRS = ['href', 'class', 'id', 'data-testid', 'contenteditable', 'aria-haspopup', 'aria-controls', 'data-user-content', 'data-message-author-role', 'translate'];
const BUDGET_MS = 8;
/** Check the clock every this many nodes (performance.now() is not free). */
const CLOCK_EVERY = 32;
const MAX_REWRITES_PER_SEC = 20;
/** More dirty roots than this in one batch: re-check every context node (throttled). */
const DIRTY_CAP = 200;
const FULL_RECHECK_MS = 200;

interface Applied {
  orig: string;
  applied: string;
}

/** A node whose string has context variants, and the elements its context is read from. */
interface CtxDep {
  attr?: string;
  anchors: Element[];
}

export interface ApplierStats {
  applied: number;
  misses: number;
}

export interface ApplierOptions {
  /** Called for UI-looking strings with no translation, or known only in other contexts (miss tracking). */
  onMiss?: (kind: EntryKind, text: string, el: Element) => void;
  /** Called when location.href changed since the last mutation batch. */
  onNavigate?: (href: string) => void;
}

const isButtonInput = (el: Element) =>
  el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(((el as HTMLInputElement).type || '').toLowerCase());

function attrKind(el: Element, attr: string): EntryKind | undefined {
  if (attr === 'value') return isButtonInput(el) ? 'value' : undefined;
  return attr as EntryKind;
}

const sameRuntimeText = (a: PackRuntime, b: PackRuntime) =>
  JSON.stringify(a.map) === JSON.stringify(b.map) && JSON.stringify(a.ctx ?? {}) === JSON.stringify(b.ctx ?? {});

export class PackApplier {
  private rt: PackRuntime;
  private rules: ElementRules;
  private text = new WeakMap<Text, Applied>();
  /** Values pinned only while we own text inside value-less native options. */
  private optionValues = new Map<HTMLOptionElement, string>();
  private textOptions = new WeakMap<Node, HTMLOptionElement>();
  private attrs = new WeakMap<Element, Map<string, Applied>>();
  /** Iterable record of everything we changed (WeakMaps cannot be enumerated). */
  private owned = new Set<Node>();
  private ctxNodes = new Map<Node, CtxDep[]>();
  private observers: MutationObserver[] = [];
  private observedRoots = new WeakSet<Node>();
  private queue = new Set<Node>();
  private attrQueue: [Element, string][] = [];
  /** Text rewritten by the app: handled before contexts are re-checked (labels may be among them). */
  private textQueue: Text[] = [];
  /** Subtree walks in progress (resumed next frame when the budget runs out). */
  private walks: Generator<void>[] = [];
  private dirty: Element[] = [];
  private dirtyOverflow = false;
  private lastFullRecheck = 0;
  private fullRecheckTimer: ReturnType<typeof setTimeout> | undefined;
  private sigCache = new WeakMap<Element, Map<EntryKind, string[]>>();
  private boundaryRoots = new Set<Node>();
  private boundaryAll = false;
  private contentCache = new WeakMap<Element, Map<string, boolean>>();
  private scheduled = false;
  private rewrites = new WeakMap<Node, { n: number; t: number }>();
  private frozen = new WeakSet<Node>();
  private href = '';
  private running = false;
  private changed = false;
  stats: ApplierStats = { applied: 0, misses: 0 };

  constructor(
    private doc: Document,
    rt: PackRuntime,
    private opts: ApplierOptions = {},
  ) {
    this.rt = rt;
    this.rules = { exclude: joinSelectors(rt.excludes) };
  }

  get active(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.href = this.doc.location?.href ?? '';
    this.observe(this.doc);
    if (this.doc.documentElement) this.enqueue(this.doc.documentElement);
    this.drain();
  }

  /** Swap in a new pack revision: undo, then apply the new map everywhere. */
  setRuntime(rt: PackRuntime): void {
    const wasRunning = this.running;
    this.restore();
    this.rt = rt;
    this.rules = { exclude: joinSelectors(rt.excludes) };
    if (wasRunning) this.start();
  }

  /**
   * Apply a new revision in place: owned nodes switch to their new translation
   * (or back to the original) without a restore/re-apply flash, and the page is
   * walked again for strings the new revision knows. Exclusion changes take the
   * full `setRuntime` path.
   */
  update(rt: PackRuntime): void {
    if (rt.excludes.join('\n') !== this.rt.excludes.join('\n') || !this.running) return this.setRuntime(rt);
    const textChanged = !sameRuntimeText(this.rt, rt);
    this.rt = rt;
    if (!textChanged) return;
    this.sigCache = new WeakMap();
    for (const n of [...this.owned]) this.recheck(n);
    if (this.doc.documentElement) this.enqueue(this.doc.documentElement);
    this.drain();
  }

  /** Undo every change still ours, stop observing. App writes made since are kept. */
  restore(): void {
    this.running = false;
    for (const o of this.observers) o.disconnect();
    this.observers = [];
    this.observedRoots = new WeakSet();
    this.queue.clear();
    this.boundaryRoots.clear();
    this.boundaryAll = false;
    this.attrQueue = [];
    this.textQueue = [];
    this.walks = [];
    this.dirty = [];
    this.dirtyOverflow = false;
    clearTimeout(this.fullRecheckTimer);
    this.fullRecheckTimer = undefined;
    const reg = packRegistry();
    for (const n of this.owned) {
      if (n.nodeType === Node.TEXT_NODE) {
        const t = n as Text;
        const a = this.text.get(t);
        if (a && t.data === a.applied) t.data = a.orig;
        this.text.delete(t);
        reg.ownedText.delete(t);
        reg.origText.delete(t);
      } else {
        const el = n as Element;
        for (const [attr, a] of this.attrs.get(el) ?? []) {
          if (el.getAttribute(attr) === a.applied) el.setAttribute(attr, a.orig);
        }
        this.attrs.delete(el);
        reg.ownedAttr.delete(el);
        reg.origAttr.delete(el);
      }
    }
    for (const option of this.optionValues.keys()) this.releaseOption(option);
    this.owned.clear();
    this.ctxNodes.clear();
    this.stats = { applied: 0, misses: 0 };
    notifyOwnership();
  }

  private observe(root: Document | ShadowRoot): void {
    if (this.observedRoots.has(root)) return;
    this.observedRoots.add(root);
    const target = root.nodeType === Node.DOCUMENT_NODE ? (root as Document) : root;
    const mo = new MutationObserver((records) => this.onRecords(records));
    mo.observe(target, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: [...ATTRS, ...STRUCTURE_ATTRS, ...BOUNDARY_ATTRS] });
    this.observers.push(mo);
  }

  /** Synchronous (microtask) handling, so translated text is in place before the next paint. */
  private onRecords(records: MutationRecord[]): void {
    if (!this.running) return;
    const tracking = this.ctxNodes.size > 0;
    let removedOwned: Node[] | undefined;
    for (const r of records) {
      if (r.type === 'childList') {
        const parent = r.target instanceof Element ? r.target.closest('table,[role="table"],[role="grid"],[role="treegrid"],ul,ol,[role="list"]') : undefined;
        this.boundaryRoots.add(parent ?? r.target);
        for (const removed of r.removedNodes) {
          if (removed.isConnected) continue;
          removedOwned ??= [...this.owned];
          if (!removedOwned.some((owned) => removed === owned || removed.contains(owned))) continue;
          for (const owned of removedOwned) {
            if (removed !== owned && !removed.contains(owned)) continue;
            if (owned.nodeType === Node.TEXT_NODE) this.giveBack(owned as Text);
            else {
              const el = owned as Element;
              for (const attr of [...(this.attrs.get(el)?.keys() ?? [])]) this.giveBackAttr(el, attr);
            }
          }
        }
        for (const n of r.addedNodes) this.enqueue(n);
        if (tracking) this.markDirty(r.target);
      } else if (r.type === 'characterData') {
        const t = r.target as Text;
        if (this.text.get(t)?.applied === t.data) continue; // our own write
        this.textQueue.push(t);
        if (tracking) this.markDirty(t.parentElement);
      } else if (r.type === 'attributes' && r.attributeName) {
        const el = r.target as Element;
        if (this.attrs.get(el)?.get(r.attributeName)?.applied === el.getAttribute(r.attributeName)) continue;
        if (BOUNDARY_ATTRS.includes(r.attributeName) || STRUCTURE_ATTRS.includes(r.attributeName)) {
          if (r.attributeName === 'href') this.boundaryAll = true;
          else this.boundaryRoots.add(el);
          this.enqueue(el);
          if (tracking) this.markDirty(el);
          continue;
        }
        if (r.attributeName === 'aria-label') this.boundaryRoots.add(el);
        this.attrQueue.push([el, r.attributeName]);
        if (tracking) this.markDirty(el);
      }
    }
    const href = this.doc.location?.href ?? '';
    if (href !== this.href) {
      this.href = href;
      this.boundaryAll = true;
      this.opts.onNavigate?.(href);
    }
    this.drain();
  }

  private markDirty(n: Node | null): void {
    if (!n || n.nodeType !== Node.ELEMENT_NODE) return;
    if (this.dirty.length >= DIRTY_CAP) this.dirtyOverflow = true;
    else this.dirty.push(n as Element);
  }

  private enqueue(n: Node): void {
    if (n.nodeType === Node.TEXT_NODE || n.nodeType === Node.ELEMENT_NODE) this.queue.add(n);
  }

  /** Work through the queue within a time budget; continue next frame if needed. */
  private drain(): void {
    if (!this.running) return;
    const t0 = performance.now();
    // Signatures and content checks are cached for one drain: the DOM is stable within it.
    this.sigCache = new WeakMap();
    this.contentCache = new WeakMap();
    if (this.boundaryAll || this.boundaryRoots.size) {
      const roots = [...this.boundaryRoots];
      for (const node of [...this.owned]) {
        if (this.boundaryAll || roots.some((root) => root.contains(node))) this.checkContentBoundary(node);
      }
      this.boundaryAll = false;
      this.boundaryRoots.clear();
    }
    while (this.attrQueue.length) {
      const [el, attr] = this.attrQueue.shift()!;
      if (!el.isConnected || skipFromAncestors(el, this.rules)) continue;
      this.applyAttr(el, attr);
    }
    // App rewrites first, so the originals that contexts are read from are current.
    while (this.textQueue.length) {
      const t = this.textQueue.shift()!;
      const parent = t.parentElement;
      if (t.isConnected && parent && !skipFromAncestors(parent, this.rules)) this.applyText(t);
    }
    this.sigCache = new WeakMap();
    this.recheckContexts();
    let steps = 0;
    outer: for (;;) {
      let walk = this.walks[0];
      if (!walk) {
        const n = this.queue.values().next().value as Node | undefined;
        if (!n) break;
        this.queue.delete(n);
        if (!n.isConnected) continue;
        walk = this.walk(n);
        this.walks.push(walk);
      }
      for (;;) {
        if (walk.next().done) {
          this.walks.shift();
          break;
        }
        if (++steps % CLOCK_EVERY === 0 && performance.now() - t0 > BUDGET_MS) break outer;
      }
    }
    if (this.changed) {
      this.changed = false;
      notifyOwnership();
    }
    if ((this.queue.size || this.walks.length) && !this.scheduled) {
      this.scheduled = true;
      const next = () => {
        this.scheduled = false;
        this.drain();
      };
      const view = this.doc.defaultView;
      if (view && this.doc.visibilityState !== 'hidden') view.requestAnimationFrame(next);
      else setTimeout(next, 0);
    }
  }

  /** Re-resolve context-dependent nodes whose surroundings changed. */
  private recheckContexts(): void {
    if (!this.ctxNodes.size) {
      this.dirty = [];
      this.dirtyOverflow = false;
      return;
    }
    if (this.dirtyOverflow) {
      // Too much changed to match precisely: re-check everything, at most every FULL_RECHECK_MS.
      const wait = FULL_RECHECK_MS - (performance.now() - this.lastFullRecheck);
      if (wait > 0) {
        this.fullRecheckTimer ??= setTimeout(() => {
          this.fullRecheckTimer = undefined;
          this.dirtyOverflow = true;
          this.drain();
        }, wait);
        return;
      }
      this.lastFullRecheck = performance.now();
    } else if (!this.dirty.length) return;
    const dirty = this.dirty;
    const all = this.dirtyOverflow;
    this.dirty = [];
    this.dirtyOverflow = false;
    for (const [n, deps] of [...this.ctxNodes]) {
      if (!n.isConnected) {
        this.ctxNodes.delete(n);
        continue;
      }
      if (all || deps.some((d) => d.anchors.some((a) => dirty.some((x) => a.contains(x) || x.contains(a))))) this.recheck(n);
    }
  }

  /** Recycled nodes and changed ancestor roles must release translations in newly personal areas. */
  private checkContentBoundary(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node as Text;
      const record = this.text.get(text);
      const parent = text.parentElement;
      if (record && (!parent || !text.isConnected || skipFromAncestors(parent, this.rules) || blockedForApply(parent) || this.isContent(parent, 'text', record.orig))) this.giveBack(text);
    } else {
      const el = node as Element;
      for (const [attr, record] of [...(this.attrs.get(el) ?? [])]) {
        const kind = attrKind(el, attr);
        if (kind && (!el.isConnected || skipFromAncestors(el, this.rules) || blockedForApply(el) || this.isContent(el, kind, record.orig))) this.giveBackAttr(el, attr);
      }
    }
  }

  /** Re-evaluate a node from its original value (owned or not: a context can come back). */
  private recheck(n: Node): void {
    if (n.nodeType === Node.TEXT_NODE) {
      this.applyText(n as Text, true);
      return;
    }
    const attrs = new Set([...(this.attrs.get(n as Element)?.keys() ?? []), ...(this.ctxNodes.get(n)?.map((d) => d.attr).filter((a): a is string => !!a) ?? [])]);
    for (const attr of attrs) this.applyAttr(n as Element, attr, true);
  }

  /** Resumable subtree walk: yields after each node so the drain can stop mid-tree. */
  private *walk(root: Node): Generator<void> {
    if (root.nodeType === Node.TEXT_NODE) {
      const parent = (root as Text).parentElement;
      if (parent && !skipFromAncestors(parent, this.rules)) this.applyText(root as Text);
      return;
    }
    const el = root as Element;
    if (skipFromAncestors(el, this.rules)) return;
    const make = () =>
      this.doc.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode: (n) =>
          n.nodeType === Node.ELEMENT_NODE && skipSubtree(n as Element, this.rules) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
      });
    let walker = make();
    let restarts = 0;
    for (let n: Node | null = el; n; n = walker.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) this.applyText(n as Text);
      else {
        const e = n as Element;
        for (const attr of ATTRS) if (e.hasAttribute(attr)) this.applyAttr(e, attr);
        const shadow = (e as HTMLElement).shadowRoot;
        if (shadow) {
          // Document observers do not see inside shadow roots: observe each one separately.
          this.observe(shadow);
          for (const c of [...shadow.childNodes]) yield* this.walk(c);
        }
      }
      yield;
      // The app removed the node we paused on: its walker would stop early, so start over
      // (already-applied nodes return immediately).
      if (!walker.currentNode.isConnected && el.isConnected && restarts++ < 3) {
        walker = make();
        walker.currentNode = el;
      }
    }
  }

  /** Context signatures of `el`, cached for the current drain. */
  private sigsOf(el: Element, kind: EntryKind): string[] {
    let byKind = this.sigCache.get(el);
    const hit = byKind?.get(kind);
    if (hit) return hit;
    const sigs = signatures(describe(el, kind));
    if (!byKind) this.sigCache.set(el, (byKind = new Map()));
    byKind.set(kind, sigs);
    return sigs;
  }

  /** Apply-time content protection (a chat titled "Settings" stays as written), cached per drain. */
  private isContent(el: Element, kind: EntryKind, src: string): boolean {
    let bySrc = this.contentCache.get(el);
    const key = kind + '\u0001' + src;
    const hit = bySrc?.get(key);
    if (hit !== undefined) return hit;
    const v = contentAt(el, kind, normalizeKey(src));
    if (!bySrc) this.contentCache.set(el, (bySrc = new Map()));
    bySrc.set(key, v);
    return v;
  }

  private trackContext(n: Node, el: Element, kind: EntryKind, src: string, attr?: string): void {
    const deps = (this.ctxNodes.get(n) ?? []).filter((d) => d.attr !== attr);
    if (hasVariants(this.rt, kind, src)) deps.push({ attr, anchors: contextAnchors(el) });
    if (deps.length) this.ctxNodes.set(n, deps);
    else this.ctxNodes.delete(n);
  }

  private throttled(n: Node): boolean {
    if (this.frozen.has(n)) return true;
    const now = performance.now();
    const r = this.rewrites.get(n);
    if (!r || now - r.t > 1000) {
      this.rewrites.set(n, { n: 1, t: now });
      return false;
    }
    if (++r.n > MAX_REWRITES_PER_SEC) {
      // The app and the pack keep overwriting each other: leave this node to the app.
      this.frozen.add(n);
      return true;
    }
    return false;
  }

  /** `force`: re-resolve even though the node still shows our translation (context or revision changed). */
  private applyText(t: Text, force = false): void {
    const current = t.data;
    const prev = this.text.get(t);
    const ours = !!prev && current === prev.applied;
    if (ours && !force) return;
    if (prev && !ours) this.release(t);
    const src = ours ? prev!.orig : current;
    if (!src.trim()) {
      // The app cleared the text: forget the old original (contexts must not read it any more).
      if (prev) this.release(t);
      this.ctxNodes.delete(t);
      return;
    }
    const parent = t.parentElement;
    if (force && ours && (!parent || skipFromAncestors(parent, this.rules))) {
      this.giveBack(t);
      return;
    }
    const hit = resolve(this.rt, 'text', src, () => (parent ? this.sigsOf(parent, 'text') : []));
    if (hit === undefined || hit === null) {
      if (prev) this.giveBack(t);
      // Known in other places only: keep watching, the right context may come back.
      if (parent) this.trackContext(t, parent, 'text', src);
      const key = normalizeKey(src);
      if (key && parent && !ours) {
        this.stats.misses++;
        this.opts.onMiss?.('text', key, parent);
      }
      return;
    }
    if (!parent || blockedForApply(parent) || this.isContent(parent, 'text', src)) {
      if (prev) this.giveBack(t);
      return;
    }
    const lead = src.match(/^\s*/)![0];
    const trail = src.match(/\s*$/)![0];
    const applied = lead + hit + trail;
    if (ours && applied === current) {
      this.trackContext(t, parent, 'text', src);
      return;
    }
    if (this.throttled(t)) return;
    const option = parent.closest('option');
    if (option && !option.hasAttribute('value')) {
      const value = option.value;
      option.setAttribute('value', value);
      this.optionValues.set(option, value);
    }
    if (option && this.optionValues.has(option)) this.textOptions.set(t, option);
    this.text.set(t, { orig: src, applied });
    packRegistry().origText.set(t, src);
    if (!this.owned.has(t)) this.own(t);
    this.trackContext(t, parent, 'text', src);
    if (current !== applied) t.data = applied;
  }

  private applyAttr(el: Element, attr: string, force = false): void {
    const kind = attrKind(el, attr);
    if (!kind) return;
    const current = el.getAttribute(attr);
    const map = this.attrs.get(el);
    const prev = map?.get(attr);
    if (current === null) {
      // The app removed the attribute: drop our record of it.
      if (prev) {
        map!.delete(attr);
        packRegistry().origAttr.get(el)?.delete(attr);
        if (!map!.size) this.release(el);
      }
      return;
    }
    const ours = !!prev && current === prev.applied;
    if (ours && !force) return;
    const src = ours ? prev!.orig : current;
    if (force && ours && skipFromAncestors(el, this.rules)) {
      this.giveBackAttr(el, attr);
      return;
    }
    const hit = src.trim() ? resolve(this.rt, kind, src, () => this.sigsOf(el, kind)) : undefined;
    if (hit === undefined || hit === null) {
      if (prev) this.giveBackAttr(el, attr);
      if (src.trim()) this.trackContext(el, el, kind, src, attr);
      if (!prev && src.trim()) {
        this.stats.misses++;
        this.opts.onMiss?.(kind, normalizeKey(src), el);
      }
      return;
    }
    if (blockedForApply(el) || this.isContent(el, kind, src)) {
      if (prev) this.giveBackAttr(el, attr);
      return;
    }
    if (ours && hit === current) {
      this.trackContext(el, el, kind, src, attr);
      return;
    }
    if (this.throttled(el)) return;
    const m = map ?? new Map<string, Applied>();
    m.set(attr, { orig: src, applied: hit });
    const reg = packRegistry();
    const origs = reg.origAttr.get(el) ?? new Map<string, string>();
    origs.set(attr, src);
    reg.origAttr.set(el, origs);
    if (!map) {
      this.attrs.set(el, m);
      this.own(el);
    }
    this.trackContext(el, el, kind, src, attr);
    if (current !== hit) el.setAttribute(attr, hit);
  }

  /** Stop translating a text node: show the original again if our value is still there. */
  private giveBack(t: Text): void {
    const prev = this.text.get(t);
    if (prev && t.data === prev.applied && prev.orig !== prev.applied) t.data = prev.orig;
    this.release(t);
  }

  private giveBackAttr(el: Element, attr: string): void {
    const map = this.attrs.get(el);
    const prev = map?.get(attr);
    if (prev && el.getAttribute(attr) === prev.applied && prev.orig !== prev.applied) el.setAttribute(attr, prev.orig);
    map?.delete(attr);
    packRegistry().origAttr.get(el)?.delete(attr);
    if (!map?.size) this.release(el);
  }

  private own(n: Node): void {
    this.owned.add(n);
    const reg = packRegistry();
    if (n.nodeType === Node.TEXT_NODE) reg.ownedText.add(n);
    else reg.ownedAttr.add(n as Element);
    this.stats.applied++;
    this.changed = true;
  }

  private releaseOption(option: HTMLOptionElement): void {
    const value = this.optionValues.get(option);
    if (value !== undefined && option.getAttribute('value') === value) option.removeAttribute('value');
    this.optionValues.delete(option);
  }

  /** Forget a node (the app replaced our value, or the pack no longer applies here). */
  private release(n: Node): void {
    if (!this.owned.delete(n)) return;
    const reg = packRegistry();
    if (n.nodeType === Node.TEXT_NODE) {
      this.text.delete(n as Text);
      reg.ownedText.delete(n);
      reg.origText.delete(n);
    } else {
      this.attrs.delete(n as Element);
      reg.ownedAttr.delete(n as Element);
      reg.origAttr.delete(n as Element);
    }
    const option = this.textOptions.get(n) ?? n.parentElement?.closest('option');
    this.textOptions.delete(n);
    if (option && this.optionValues.has(option)) {
      const walker = this.doc.createTreeWalker(option, NodeFilter.SHOW_TEXT);
      let owned = false;
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (this.owned.has(text)) { owned = true; break; }
      }
      if (!owned) this.releaseOption(option);
    }
    this.stats.applied = Math.max(0, this.stats.applied - 1);
    this.changed = true;
  }
}
