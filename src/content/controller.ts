import { containsOwned, onOwnershipChange } from '../pack/registry';
import { Readability } from '@mozilla/readability';
import type { TabState, ToBackground, ToContent } from '../shared/messages';
import { isTranslatable, normalizeSpace, stripMarkup } from '../shared/text';
import type { DisplayMode, PageContext, PageInfo, SegmentPayload, TransFontSize, TransLineHeight, TransStyle } from '../shared/types';
import { blockAncestor, collectRuns, OUR_TAGS, shouldSkip, StyleProbe } from './extract';
import {
  applyRootClasses,
  createTransEl,
  detectDarkPage,
  needsFit,
  setContent,
  setError,
  setState,
  unwrapOriginal,
  wrapOriginal,
} from './render';
import { buildFragment, serializeRun } from './serialize';

export interface Transport {
  send(msg: ToBackground): void;
  /** Called by the transport for every message from the background. */
  onMessage: ((msg: ToContent) => void) | null;
  /** Called when the background connection dropped (service worker restart). */
  onDisconnect: (() => void) | null;
}

export interface ControllerOptions {
  mode: DisplayMode;
  transStyle: TransStyle;
  fontSize?: TransFontSize;
  lineHeight?: TransLineHeight;
  include?: string;
  exclude?: string;
  /** Send an article excerpt for topic/term extraction: 'auto' only on long pages. */
  preprocess: 'auto' | 'on' | 'off';
  /** False: this document must not be translated now (a frame holding sign-in or payment fields). */
  canStart?: () => boolean;
}

type Status = 'idle' | 'queued' | 'loading' | 'done' | 'error';

interface Seg {
  id: number;
  nodes: Node[];
  parent: Element;
  text: string;
  slots: Map<string, Node>;
  outer: Element[];
  lead: string;
  trail: string;
  el: HTMLElement;
  status: Status;
  translation?: string;
  refined?: boolean;
  wrap?: HTMLElement | null;
  /** Watched via Range rects instead of IntersectionObserver (giant parents). */
  rangeWatch?: boolean;
  /** Tight container (nav row, clamped card): inline, single line, ellipsis. */
  fit?: boolean;
  /** Enclosing nav/header, whose height is watched for wrap blow-ups. */
  navBox?: Element | null;
  /** Inside a carousel: paragraphs become tooltips straight away. */
  carousel?: boolean;
}

const FLUSH_MS = 80;
/** Small window so the first request collects every viewport segment from staggered IO callbacks. */
const FIRST_FLUSH_MS = 20;
const MUTATION_DEBOUNCE_MS = 300;
const ROOT_MARGIN = 800;
const INLINE_MAX_CHARS = 40;
const SHORT_PRIORITY_CHARS = 30;
const ARTICLE_MIN_CHARS = 2500;
const ESTIMATE_TTL_MS = 5000;
// Only real menus: <header> often holds hero copy that must stay visible.
const NAV_SELECTOR = 'nav, [role="navigation"]';
/** A nav/header may grow this much (ratio and px) before its translations become tooltips. */
const NAV_GROWTH = 1.3;
const NAV_GROWTH_PX = 8;
/** Fixed-height rotating widgets; overlays (pagers, arrows) sit on top, so overflow checks can't see clashes. */
const CAROUSEL_SELECTOR =
  '[aria-roledescription="carousel"], [aria-roledescription="slide"], .carousel, .slider, .slideshow, .swiper, .swiper-slide, .slick-slide, .splide__slide';
const DEBUG = import.meta.env?.MODE === 'debug';

export class Controller {
  enabled = false;
  expertOverride = '';
  resolvedExpert: { id: string; name: string } | null = null;
  /** Per-request metrics from the background (timing always, details in debug builds). */
  metrics: Record<string, unknown>[] = [];
  pageInfo: PageInfo | null = null;

  private doc: Document;
  private segs = new Map<number, Seg>();
  private nextId = 1;
  private nodeSeg = new WeakMap<Node, number>();
  private offOwnership: (() => void) | undefined;
  private parentSegs = new WeakMap<Element, Set<number>>();
  /** text → translation for the page lifetime (dedupe of nav/footer strings). */
  private memo = new Map<string, string>();
  /** text → seg ids waiting on an in-flight request for that text. */
  private waiting = new Map<string, number[]>();
  /** request id (first seg sent for a text) → text */
  private inflight = new Map<number, string>();
  private queue: Seg[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private io: IntersectionObserver | null = null;
  private mo: MutationObserver | null = null;
  private dirty = new Set<Node>();
  private mutationTimer: ReturnType<typeof setTimeout> | undefined;
  private rangeSegs = new Set<number>();
  private scrollHandler = () => this.checkRanges();
  private rafPending = false;
  private preprocessSent = false;
  private lastContextTarget: Node | null = null;
  private startedAt = 0;
  private firstPaintMs: number | null = null;
  private ttfts: number[] = [];
  private estimateCache: { at: number; count: number } | null = null;
  private purging = false;
  private navHeights = new WeakMap<Element, number>();
  private tightBoxes = new WeakSet<Element>();
  private layoutQueue = new Set<Seg>();
  private layoutRaf = 0;

  constructor(
    private transport: Transport,
    private opts: ControllerOptions,
    doc: Document = document,
  ) {
    this.doc = doc;
    transport.onMessage = (m) => this.onMessage(m);
    transport.onDisconnect = () => this.onDisconnect();
    doc.addEventListener('contextmenu', (e) => (this.lastContextTarget = e.target as Node), true);
  }

  // ---------- public API ----------

  start(): void {
    if (this.enabled || this.opts.canStart?.() === false) return;
    this.enabled = true;
    this.startedAt = performance.now();
    this.firstPaintMs = null;
    this.doc.documentElement.classList.toggle('xt-dark-page', detectDarkPage(this.doc));
    this.applyClasses();
    const win = this.doc.defaultView!;
    this.io = new win.IntersectionObserver((entries) => this.onIntersect(entries), {
      rootMargin: `${ROOT_MARGIN}px 0px ${ROOT_MARGIN}px 0px`,
    });
    this.mo = new win.MutationObserver((muts) => this.onMutations(muts));
    this.mo.observe(this.doc.body, { childList: true, subtree: true, characterData: true });
    win.addEventListener('scroll', this.scrollHandler, { passive: true, capture: true });
    win.addEventListener('resize', this.scrollHandler, { passive: true });
    for (const root of this.roots()) this.scan(root);
    this.checkRanges();
    this.offOwnership = onOwnershipChange(() => this.dropPackOwned());
  }

  /** A language pack took over some nodes: remove article segments that cover them. */
  private dropPackOwned(): void {
    for (const seg of [...this.segs.values()]) {
      if (seg.nodes.some(containsOwned)) {
        this.removeSeg(seg);
        this.segs.delete(seg.id);
      }
    }
  }

  stop(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.transport.send({ type: 'reset' });
    this.io?.disconnect();
    this.mo?.disconnect();
    this.io = this.mo = null;
    const win = this.doc.defaultView!;
    win.removeEventListener('scroll', this.scrollHandler, { capture: true });
    win.removeEventListener('resize', this.scrollHandler);
    clearTimeout(this.flushTimer);
    clearTimeout(this.mutationTimer);
    this.offOwnership?.();
    this.offOwnership = undefined;
    for (const seg of this.segs.values()) this.removeSeg(seg);
    this.segs.clear();
    this.queue = [];
    this.waiting.clear();
    this.inflight.clear();
    this.rangeSegs.clear();
    this.dirty.clear();
    this.applyClasses();
  }

  toggle(): void {
    if (this.enabled) this.stop();
    else this.start();
  }

  setMode(mode: DisplayMode): void {
    this.opts.mode = mode;
    if (mode === 'replace') for (const seg of this.segs.values()) this.ensureWrapped(seg);
    this.applyClasses();
  }

  setStyle(style: TransStyle): void {
    this.opts.transStyle = style;
    this.applyClasses();
  }

  updateOptions(patch: Partial<ControllerOptions>): void {
    Object.assign(this.opts, patch);
    this.applyClasses();
  }

  get mode(): DisplayMode {
    return this.opts.mode;
  }

  /** Changing the expert changes every translation: start over. */
  setExpert(expertId: string): void {
    this.expertOverride = expertId;
    this.memo.clear();
    if (this.enabled) {
      this.stop();
      this.start();
    }
  }

  refineAtCursor(): void {
    this.refine(this.segAt(this.lastContextTarget));
  }

  /** Popup quick action: 精翻 the paragraph holding the current selection. */
  refineSelection(): boolean {
    const seg = this.segAt(this.selectionNode());
    this.refine(seg);
    return !!seg;
  }

  /** Re-request every segment that ended in an error. */
  retryFailed(): number {
    const failed = [...this.segs.values()].filter((s) => s.status === 'error');
    for (const seg of failed) {
      seg.status = 'idle';
      this.enqueue(seg);
    }
    return failed.length;
  }

  /** Drop this page's cached translations and translate again (after editing rules or glossary). */
  purgePage(): void {
    if (!this.enabled || this.purging) return;
    const texts = [...new Set([...this.segs.values()].filter((s) => s.status === 'done' || s.status === 'error').map((s) => s.text))];
    this.purging = true;
    this.transport.send({ type: 'purge', ctx: this.ctx(), texts, expertOverride: this.expertOverride || undefined });
  }

  private selectionNode(): Node | null {
    const sel = this.doc.defaultView?.getSelection();
    return sel && sel.rangeCount && !sel.isCollapsed ? sel.anchorNode : null;
  }

  private refine(seg: Seg | undefined): void {
    if (!seg) return;
    if (!this.enabled) this.start();
    this.insert(seg);
    setState(seg.el, 'refining');
    this.transport.send({
      type: 'refine',
      ctx: this.ctx(),
      segment: { id: seg.id, text: seg.text },
      expertOverride: this.expertOverride || undefined,
    });
  }

  state(): TabState {
    let done = 0;
    let errors = 0;
    let pending = 0;
    for (const s of this.segs.values()) {
      if (s.status === 'done') done++;
      else if (s.status === 'error') errors++;
      else if (s.status === 'queued' || s.status === 'loading') pending++;
    }
    const avg = this.ttfts.length ? Math.round(this.ttfts.reduce((a, b) => a + b, 0) / this.ttfts.length) : null;
    return {
      enabled: this.enabled,
      mode: this.opts.mode,
      expertOverride: this.expertOverride,
      resolvedExpert: this.resolvedExpert,
      stats: { segments: this.segs.size, done, errors, pending },
      firstPaintMs: this.firstPaintMs,
      avgTtftMs: avg,
      lang: pageLang(this.doc),
      estimate: this.enabled ? null : this.estimate(),
      pageInfo: this.pageInfo,
      selectionInSegment: !!this.segAt(this.selectionNode()),
    };
  }

  /** Count translatable segments without translating (popup's idle view). */
  private estimate(): number {
    const now = Date.now();
    if (this.estimateCache && now - this.estimateCache.at < ESTIMATE_TTL_MS) return this.estimateCache.count;
    let count = 0;
    try {
      const probe = new StyleProbe();
      for (const root of this.roots()) count += collectRuns(root, { exclude: this.opts.exclude }, probe).length;
    } catch {
      // estimation is best-effort
    }
    this.estimateCache = { at: now, count };
    return count;
  }

  // ---------- scanning ----------

  private roots(): Element[] {
    if (this.opts.include) {
      try {
        const found = [...this.doc.querySelectorAll(this.opts.include)];
        if (found.length) return found;
      } catch {
        // invalid selector: fall back to body
      }
    }
    return [this.doc.body];
  }

  private inScope(el: Element): boolean {
    if (!this.opts.include) return true;
    try {
      return !!el.closest(this.opts.include) || !!el.querySelector(this.opts.include);
    } catch {
      return true;
    }
  }

  private scan(root: Element, probe = new StyleProbe()): void {
    // Respect exclude/skip rules of ancestors when scanning a subtree after a mutation.
    for (let a = root.parentElement; a; a = a.parentElement) {
      if (shouldSkip(a, this.opts.exclude)) return;
    }
    // Nodes a site language pack translated in place (or contain such nodes) are UI chrome already done.
    const runs = collectRuns(root, { exclude: this.opts.exclude, isProcessed: (n) => this.nodeSeg.has(n) || containsOwned(n) }, probe);
    const viewportH = this.doc.defaultView!.innerHeight || 800;
    for (const run of runs) {
      const { text, slots, outer, lead, trail } = serializeRun(run.nodes, (el) => probe.isHidden(el) || shouldSkip(el, this.opts.exclude));
      // Plain-text filtering in collectRuns also counts hidden <style>/<script> text; re-check what we would actually send.
      if (!isTranslatable(text)) continue;
      const id = this.nextId++;
      const tag = run.parent.tagName;
      const heading = /^H[1-6]$/.test(tag);
      const fit = needsFit(run.parent);
      const inline = fit || (stripMarkup(text).length <= INLINE_MAX_CHARS && !heading);
      const el = createTransEl(this.doc, id, inline, {
        heading,
        cell: tag === 'TD' || tag === 'TH',
        fit,
      });
      const carousel = !!run.parent.closest(CAROUSEL_SELECTOR);
      const seg: Seg = { id, nodes: run.nodes, parent: run.parent, text, slots, outer, lead, trail, el, status: 'idle', fit, carousel };
      this.segs.set(id, seg);
      for (const n of run.nodes) this.nodeSeg.set(n, id);
      let set = this.parentSegs.get(run.parent);
      if (!set) this.parentSegs.set(run.parent, (set = new Set()));
      set.add(id);

      const memo = this.memo.get(text);
      if (memo !== undefined) {
        this.insert(seg);
        this.render(seg, memo);
        continue;
      }
      // A parent taller than 3 screens would intersect forever; watch the run itself.
      const h = run.parent.getBoundingClientRect().height;
      if (h > viewportH * 3) {
        seg.rangeWatch = true;
        this.rangeSegs.add(id);
      } else {
        this.io!.observe(run.parent);
      }
    }
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      this.io?.unobserve(e.target);
      for (const id of this.parentSegs.get(e.target as Element) ?? []) {
        const seg = this.segs.get(id);
        if (seg && seg.status === 'idle' && !seg.rangeWatch) this.enqueue(seg);
      }
    }
  }

  private checkRanges(): void {
    if (this.rafPending || !this.rangeSegs.size) return;
    this.rafPending = true;
    const win = this.doc.defaultView!;
    win.requestAnimationFrame(() => {
      this.rafPending = false;
      const top = -ROOT_MARGIN;
      const bottom = win.innerHeight + ROOT_MARGIN;
      const range = this.doc.createRange();
      for (const id of [...this.rangeSegs]) {
        const seg = this.segs.get(id);
        if (!seg || seg.status !== 'idle') {
          this.rangeSegs.delete(id);
          continue;
        }
        const first = seg.nodes[0]!;
        const last = seg.nodes[seg.nodes.length - 1]!;
        if (!first.isConnected || !last.isConnected) continue;
        range.setStartBefore(first);
        range.setEndAfter(last);
        const r = range.getBoundingClientRect();
        if (r.bottom >= top && r.top <= bottom) {
          this.rangeSegs.delete(id);
          this.enqueue(seg);
        }
      }
    });
  }

  // ---------- requests ----------

  /**
   * Debug builds: queue the next idle segments in page order, as one scroll wave
   * would. Automation runs in occluded windows where IntersectionObserver never fires.
   */
  debugEnqueueWave(limit: number): number {
    let n = 0;
    for (const seg of this.segs.values()) {
      if (n >= limit) break;
      if (seg.status !== 'idle') continue;
      this.rangeSegs.delete(seg.id);
      this.enqueue(seg);
      n++;
    }
    return n;
  }

  private enqueue(seg: Seg): void {
    this.insert(seg);
    const memo = this.memo.get(seg.text);
    if (memo !== undefined) return this.render(seg, memo);
    seg.status = 'queued';
    setState(seg.el, 'loading');
    this.queue.push(seg);
    // First flush goes out almost immediately; later ones are coalesced.
    this.flushTimer ??= setTimeout(() => this.flush(), this.inflight.size ? FLUSH_MS : FIRST_FLUSH_MS);
  }

  private flush(): void {
    this.flushTimer = undefined;
    if (!this.enabled || !this.queue.length) return;
    const segments: SegmentPayload[] = [];
    // Body text first, short UI strings (nav, TOC, buttons) after: the background's
    // small first batch then paints actual paragraphs instead of menu items.
    const isShort = (s: Seg) => stripMarkup(s.text).length < SHORT_PRIORITY_CHARS;
    const ordered = [...this.queue.filter((s) => !isShort(s)), ...this.queue.filter(isShort)];
    for (const seg of ordered) {
      if (seg.status !== 'queued') continue;
      seg.status = 'loading';
      const waiters = this.waiting.get(seg.text);
      if (waiters) {
        waiters.push(seg.id); // same text already requested
        continue;
      }
      this.waiting.set(seg.text, [seg.id]);
      this.inflight.set(seg.id, seg.text);
      segments.push({ id: seg.id, text: seg.text });
    }
    this.queue = [];
    if (segments.length) {
      this.transport.send({
        type: 'translate',
        ctx: this.ctx(),
        segments,
        expertOverride: this.expertOverride || undefined,
      });
    }
    this.maybePreprocess();
  }

  private maybePreprocess(): void {
    if (this.preprocessSent || this.opts.preprocess === 'off') return;
    this.preprocessSent = true;
    // Off the critical path: the first batch is already on its way.
    setTimeout(() => {
      const article = extractArticle(this.doc);
      if (!article) return;
      if (this.opts.preprocess === 'auto' && article.length < ARTICLE_MIN_CHARS) return;
      this.transport.send({ type: 'preprocess', ctx: this.ctx(), article: article.slice(0, 6000) });
    }, 0);
  }

  private ctx(): PageContext {
    const loc = this.doc.defaultView!.location;
    // Drop the #fragment: in-page anchors are the same document (one preprocess, one page info).
    return { url: loc.href.split('#')[0]!, host: loc.hostname, title: this.doc.title };
  }

  private onMessage(msg: ToContent): void {
    switch (msg.type) {
      case 'result': {
        const text = this.inflight.get(msg.id) ?? this.segs.get(msg.id)?.text;
        if (text === undefined) return;
        this.inflight.delete(msg.id);
        this.memo.set(text, msg.text);
        const ids = this.waiting.get(text) ?? [msg.id];
        this.waiting.delete(text);
        for (const id of ids) {
          const seg = this.segs.get(id);
          if (seg) this.render(seg, msg.text);
        }
        return;
      }
      case 'refined': {
        const seg = this.segs.get(msg.id);
        if (!seg) return;
        this.memo.set(seg.text, msg.text);
        this.render(seg, msg.text, true);
        return;
      }
      case 'error': {
        for (const reqId of msg.ids) {
          const text = this.inflight.get(reqId) ?? this.segs.get(reqId)?.text;
          if (text === undefined) continue;
          this.inflight.delete(reqId);
          const ids = this.waiting.get(text) ?? [reqId];
          this.waiting.delete(text);
          for (const id of ids) {
            const seg = this.segs.get(id);
            if (!seg) continue;
            if (seg.status === 'done') {
              setState(seg.el, 'done', msg.message); // failed refine keeps the old text
              continue;
            }
            seg.status = 'error';
            setError(seg.el, msg.message, () => this.enqueue(seg));
          }
        }
        return;
      }
      case 'expert':
        this.resolvedExpert = { id: msg.id, name: msg.name };
        return;
      case 'metric':
        this.metrics.push(msg.data);
        if (typeof msg.data.ttftMs === 'number' && msg.data.ttftMs > 0) this.ttfts.push(msg.data.ttftMs);
        if (DEBUG) console.info('[xt-metric] ' + JSON.stringify(msg.data));
        return;
      case 'page-info':
        this.pageInfo = msg.info;
        return;
      case 'purged':
        this.purging = false;
        this.memo.clear();
        if (this.enabled) {
          this.stop();
          this.start();
        }
        return;
    }
  }

  /** Service worker restarted: everything in flight is lost, ask again. */
  private onDisconnect(): void {
    if (!this.enabled) return;
    this.preprocessSent = false; // the new worker has no page info
    const lost = [...this.segs.values()].filter((s) => s.status === 'loading' || s.status === 'queued');
    this.waiting.clear();
    this.inflight.clear();
    this.queue = [];
    for (const seg of lost) seg.status = 'idle';
    for (const seg of lost) this.enqueue(seg);
  }

  // ---------- DOM ----------

  private insert(seg: Seg): void {
    if (seg.el.isConnected) return;
    const anchor = seg.wrap ?? seg.nodes[seg.nodes.length - 1];
    if (!anchor?.parentNode) return;
    if (seg.navBox === undefined) seg.navBox = seg.parent.closest(NAV_SELECTOR);
    if (seg.navBox && !this.navHeights.has(seg.navBox)) {
      this.navHeights.set(seg.navBox, seg.navBox.getBoundingClientRect().height);
    }
    anchor.parentNode.insertBefore(seg.el, anchor.nextSibling);
  }

  /** Translation moves into the parent's tooltip; the page keeps its original layout. */
  private toTip(seg: Seg): void {
    if (seg.el.hasAttribute('data-tip') || !seg.translation) return;
    seg.el.setAttribute('data-tip', '');
    seg.parent.setAttribute('title', normalizeSpace(stripMarkup(seg.translation)));
  }

  private queueLayoutCheck(seg: Seg): void {
    this.layoutQueue.add(seg);
    if (this.layoutRaf) return;
    this.layoutRaf = this.doc.defaultView!.requestAnimationFrame(() => this.checkLayout());
  }

  /**
   * Post-insert layout guard, batched per frame (one layout pass for all reads):
   * - a nav/header that grew noticeably (items wrapped onto a new row) → its translations become tooltips;
   * - a fixed-height box that now overflows because of a translation (slideshows, cards) → tooltip.
   */
  private checkLayout(): void {
    this.layoutRaf = 0;
    const segs = [...this.layoutQueue].filter((s) => s.status === 'done' && s.el.isConnected && !s.el.hasAttribute('data-tip'));
    this.layoutQueue.clear();
    if (this.opts.mode === 'replace' || !segs.length) return;
    const win = this.doc.defaultView!;

    const grownNavs = new Set<Element>();
    for (const seg of segs) {
      const nav = seg.navBox;
      if (!nav || this.tightBoxes.has(nav) || grownNavs.has(nav)) continue;
      const base = this.navHeights.get(nav) ?? 0;
      const now = nav.getBoundingClientRect().height;
      if (base > 0 && now > base * NAV_GROWTH && now - base > NAV_GROWTH_PX) grownNavs.add(nav);
    }
    for (const nav of grownNavs) this.tightBoxes.add(nav);
    // Only menu-like items (short, inline) move to tooltips; a paragraph inside a nav stays.
    const menuItem = (seg: Seg) => seg.el.classList.contains('xt-inline') || seg.el.classList.contains('xt-fit');
    for (const seg of this.segs.values()) if (seg.navBox && grownNavs.has(seg.navBox) && menuItem(seg)) this.toTip(seg);

    for (const seg of segs) {
      if (seg.el.hasAttribute('data-tip')) continue;
      for (let el: Element | null = seg.parent, i = 0; el && el !== this.doc.body && i < 4; el = el.parentElement, i++) {
        const ov = win.getComputedStyle(el).overflowY;
        if (ov === 'auto' || ov === 'scroll') break; // scroll containers may grow freely
        const over = el.scrollHeight - el.clientHeight;
        if (el.clientHeight === 0 || over <= 4) continue;
        // Overflowing: was it us? Measure again without the translation.
        seg.el.style.display = 'none';
        const without = el.scrollHeight - el.clientHeight;
        seg.el.style.display = '';
        if (over - without > 4) this.toTip(seg);
        break;
      }
    }
  }

  private render(seg: Seg, translation: string, refined = false): void {
    this.insert(seg);
    seg.status = 'done';
    seg.translation = translation;
    seg.refined = refined;
    // Names, brands and "Python" come back unchanged: showing them twice is noise.
    const same = normalizeSpace(stripMarkup(translation)) === normalizeSpace(stripMarkup(seg.text));
    seg.el.toggleAttribute('data-same', same);
    // An unchanged name shows as its original: unwrap it if replace mode hid it for an earlier translation.
    if (same && seg.wrap) {
      unwrapOriginal(seg.wrap);
      seg.wrap = null;
    }
    const { fragment } = buildFragment(translation, seg.slots, this.doc, seg.outer, seg);
    setContent(seg.el, fragment, refined);
    if (this.firstPaintMs === null && !same) this.firstPaintMs = Math.round(performance.now() - this.startedAt);
    if (this.opts.mode === 'replace' && !same) this.ensureWrapped(seg);
    if (!same) {
      const menuItem = seg.el.classList.contains('xt-inline') || seg.el.classList.contains('xt-fit');
      if (seg.navBox && menuItem && this.tightBoxes.has(seg.navBox)) this.toTip(seg);
      // Long copy in a carousel clashes with its pager/arrows; short slide titles still fit.
      else if (seg.carousel && !menuItem && stripMarkup(seg.text).length > INLINE_MAX_CHARS && this.opts.mode !== 'replace') this.toTip(seg);
      else this.queueLayoutCheck(seg);
    }
  }

  private ensureWrapped(seg: Seg): void {
    if (seg.status !== 'done' || seg.wrap || seg.el.hasAttribute('data-same')) return;
    seg.wrap = wrapOriginal(this.doc, seg.nodes);
  }

  private removeSeg(seg: Seg): void {
    if (seg.el.hasAttribute('data-tip')) seg.parent.removeAttribute('title');
    seg.el.remove();
    if (seg.wrap) unwrapOriginal(seg.wrap);
    for (const n of seg.nodes) this.nodeSeg.delete(n);
    this.parentSegs.get(seg.parent)?.delete(seg.id);
    this.rangeSegs.delete(seg.id);
  }

  private applyClasses(): void {
    applyRootClasses(this.doc, this.enabled, this.opts.mode, this.opts.transStyle, this.opts.fontSize, this.opts.lineHeight);
  }

  private segAt(target: Node | null): Seg | undefined {
    for (let n: Node | null = target; n; n = n.parentNode) {
      if (n.nodeType === Node.ELEMENT_NODE && (n as Element).tagName === 'XT-TRANS') {
        return this.segs.get(Number((n as Element).getAttribute('data-xt')));
      }
      const id = this.nodeSeg.get(n);
      if (id) return this.segs.get(id);
      const ids = n.nodeType === Node.ELEMENT_NODE ? this.parentSegs.get(n as Element) : undefined;
      if (ids?.size) return this.segs.get([...ids][0]!);
    }
    return undefined;
  }

  // ---------- dynamic content ----------

  private isOurs(node: Node): boolean {
    for (let n: Node | null = node; n; n = n.parentNode) {
      if (n.nodeType === Node.ELEMENT_NODE && OUR_TAGS.has((n as Element).tagName)) return true;
    }
    return false;
  }

  private onMutations(muts: MutationRecord[]): void {
    for (const m of muts) {
      if (this.isOurs(m.target)) continue;
      if (m.type === 'characterData') {
        this.dirty.add(m.target);
        continue;
      }
      for (const n of m.addedNodes) {
        if (n.nodeType === Node.ELEMENT_NODE && OUR_TAGS.has((n as Element).tagName)) continue;
        if (n.nodeType === Node.TEXT_NODE || n.nodeType === Node.ELEMENT_NODE) this.dirty.add(n);
      }
      if (m.removedNodes.length) this.dirty.add(m.target);
    }
    if (this.dirty.size) {
      clearTimeout(this.mutationTimer);
      this.mutationTimer = setTimeout(() => this.processDirty(), MUTATION_DEBOUNCE_MS);
    }
  }

  private processDirty(): void {
    if (!this.enabled) return;
    const probe = new StyleProbe();
    const blocks = new Set<Element>();
    for (const n of this.dirty) {
      if (!n.isConnected) continue;
      const isInlineChange =
        n.nodeType === Node.TEXT_NODE || (n.nodeType === Node.ELEMENT_NODE && probe.isInline(n as Element));
      const block = isInlineChange ? blockAncestor(n, probe) : (n as Element);
      if (block && this.inScope(block)) blocks.add(block);
    }
    this.dirty.clear();

    // Drop segments whose original text was removed or edited.
    for (const seg of [...this.segs.values()]) {
      const detached = !seg.nodes.every((n) => n.isConnected);
      const edited = blocks.has(seg.parent) && this.runChanged(seg, probe);
      if (detached || edited) {
        this.removeSeg(seg);
        this.segs.delete(seg.id);
      }
    }

    // Scan only outermost dirty blocks.
    for (const b of blocks) {
      let covered = false;
      for (let a = b.parentElement; a; a = a.parentElement) {
        if (blocks.has(a)) {
          covered = true;
          break;
        }
      }
      if (!covered) this.scan(b, probe);
    }
    this.checkRanges();
  }

  private runChanged(seg: Seg, probe: StyleProbe): boolean {
    const now = serializeRun(seg.wrap ? [...seg.wrap.childNodes] : seg.nodes, (el) => probe.isHidden(el)).text;
    return normalizeSpace(stripMarkup(now)) !== normalizeSpace(stripMarkup(seg.text));
  }
}

/** html lang, else a script-based guess from the first visible text. */
export function pageLang(doc: Document): string {
  const lang = doc.documentElement.lang?.trim();
  if (lang) return lang.toLowerCase();
  const sample = (doc.body?.innerText ?? '').slice(0, 2000);
  if (/[\u3040-\u30ff]/.test(sample)) return 'ja';
  if (/[\uac00-\ud7af]/.test(sample)) return 'ko';
  if (/[\u0400-\u04ff]{20}/.test(sample)) return 'ru';
  if (/[\u4e00-\u9fff]/.test(sample) && (sample.match(/[\u4e00-\u9fff]/g)?.length ?? 0) > sample.length / 4) return 'zh';
  return 'en';
}

function extractArticle(doc: Document): string {
  try {
    const clone = doc.cloneNode(true) as Document;
    clone.querySelectorAll('xt-trans').forEach((e) => e.remove());
    const parsed = new Readability(clone).parse();
    return normalizeSpace(parsed?.textContent ?? '');
  } catch {
    return '';
  }
}
