import type { DisplayMode, TransFontSize, TransLineHeight, TransStyle } from '../shared/types';

export type SegState = 'loading' | 'done' | 'error' | 'refining';

export interface TransLayout {
  heading?: boolean;
  cell?: boolean;
  fit?: boolean;
}

/** `<xt-trans>` sits right after the original run; a custom tag avoids most site CSS. */
export function createTransEl(doc: Document, id: number, inline: boolean, layout: TransLayout = {}): HTMLElement {
  const el = doc.createElement('xt-trans');
  el.setAttribute('data-xt', String(id));
  const cls = [inline ? 'xt-inline' : 'xt-block'];
  if (layout.heading) cls.push('xt-heading');
  if (layout.cell) cls.push('xt-cell');
  if (layout.fit) cls.push('xt-fit');
  el.className = cls.join(' ');
  el.setAttribute('translate', 'no');
  // Han glyphs differ between zh / ja / ko fonts; tell the browser which to use.
  el.setAttribute('lang', 'zh-CN');
  return el;
}

// Defaults (row / nowrap) may come back empty from some engines: test for the opposite instead.
const isRow = (cs: CSSStyleDeclaration) =>
  (cs.display.includes('flex') && !cs.flexDirection.startsWith('column') && !cs.flexWrap.startsWith('wrap')) ||
  cs.display.includes('grid');

/**
 * Tight containers where a block translation would break the layout: items of a
 * single-line flex/grid row (nav bars, tab strips, toolbars) and anything inside a
 * line-clamped or fixed-height, overflow-hidden box (card titles).
 */
export function needsFit(parent: Element): boolean {
  const win = parent.ownerDocument.defaultView;
  if (!win) return false;
  const own = win.getComputedStyle(parent);
  // Only short labels: a long paragraph in a flex row reads fine as a side-by-side item.
  const short = (parent.textContent?.trim().length ?? 0) < 80;
  if (short && isRow(own) && !/^H[1-6]$/.test(parent.tagName)) return true;
  const up = parent.parentElement;
  if (short && up && isRow(win.getComputedStyle(up))) return true;
  for (let el: Element | null = parent, i = 0; el && i < 3; el = el.parentElement, i++) {
    const cs = i === 0 ? own : win.getComputedStyle(el);
    const clamp = cs.getPropertyValue('-webkit-line-clamp');
    if (clamp && clamp !== 'none') return true;
    if (cs.textOverflow === 'ellipsis' && cs.whiteSpace === 'nowrap') return true;
    const ov = cs.overflowY || cs.overflow;
    if ((ov.startsWith('hidden') || ov.startsWith('clip')) && cs.maxHeight && cs.maxHeight !== 'none') return true;
  }
  return false;
}

/** Relative luminance of the page background; dark pages get translucent styles. */
export function detectDarkPage(doc: Document): boolean {
  const win = doc.defaultView;
  if (!win) return false;
  for (const el of [doc.body, doc.documentElement]) {
    if (!el) continue;
    const m = win.getComputedStyle(el).backgroundColor.match(/rgba?\(([^)]+)\)/);
    if (!m) continue;
    const [r, g, b, a = 1] = m[1]!.split(',').map((x) => parseFloat(x));
    if (a < 0.5) continue;
    const lin = (c: number) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!) < 0.18;
  }
  return false;
}

export function setState(el: HTMLElement, state: SegState, title?: string): void {
  el.setAttribute('data-state', state);
  if (title) el.title = title;
  else el.removeAttribute('title');
  if (state === 'loading' && !el.firstChild) {
    el.appendChild(el.ownerDocument.createElement('xt-spin'));
  }
}

export function setContent(el: HTMLElement, fragment: DocumentFragment, refined = false): void {
  el.replaceChildren(fragment);
  setState(el, 'done');
  el.toggleAttribute('data-refined', refined);
}

export function setError(el: HTMLElement, message: string, onRetry: () => void): void {
  const btn = el.ownerDocument.createElement('xt-retry');
  btn.textContent = '⟳ 翻译失败，点击重试';
  btn.addEventListener(
    'click',
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      onRetry();
    },
    { once: true },
  );
  el.replaceChildren(btn);
  setState(el, 'error', message);
}

/**
 * Replace mode hides originals by wrapping them in <xt-orig>. Wrapping only
 * happens the first time replace mode is used for a segment; afterwards the
 * switch is a pure CSS class flip.
 */
export function wrapOriginal(doc: Document, nodes: Node[]): HTMLElement | null {
  const first = nodes[0];
  if (!first?.parentNode || !nodes.every((n) => n.parentNode === first.parentNode)) return null;
  const wrap = doc.createElement('xt-orig');
  first.parentNode.insertBefore(wrap, first);
  for (const n of nodes) wrap.appendChild(n);
  return wrap;
}

export function unwrapOriginal(wrap: HTMLElement): void {
  const parent = wrap.parentNode;
  if (!parent) return;
  while (wrap.firstChild) parent.insertBefore(wrap.firstChild, wrap);
  wrap.remove();
}

export function applyRootClasses(
  doc: Document,
  enabled: boolean,
  mode: DisplayMode,
  style: TransStyle,
  fontSize: TransFontSize = 'same',
  lineHeight: TransLineHeight = 'comfortable',
): void {
  const cl = doc.documentElement.classList;
  cl.toggle('xt-on', enabled);
  cl.toggle('xt-replace', enabled && mode === 'replace');
  for (const s of ['plain', 'faded', 'border', 'dashed', 'tint']) cl.toggle(`xt-style-${s}`, s === style);
  cl.toggle('xt-fs-small', fontSize === 'small');
  for (const l of ['comfortable', 'compact', 'inherit']) cl.toggle(`xt-lh-${l}`, l === lineHeight);
}
