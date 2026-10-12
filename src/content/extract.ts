import { isTranslatable, normalizeSpace } from '../shared/text';
import { ATOM_TAGS, isFormula } from './serialize';

export const OUR_TAGS = new Set(['XT-TRANS', 'XT-ORIG']);

/** Containers whose content is never translated. */
const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT',
  'EMBED', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'BUTTON', 'PRE', 'CODE', 'KBD', 'SAMP', 'HEAD', 'TITLE',
  'XT-TRANS', 'XT-ORIG',
]);

/** Fallback when computed style is unavailable. */
const INLINE_TAGS = new Set([
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'BIG', 'BR', 'CITE', 'CODE', 'DATA', 'DEL', 'DFN', 'EM', 'FONT', 'I', 'IMG',
  'INS', 'KBD', 'LABEL', 'MARK', 'Q', 'RP', 'RT', 'RUBY', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRIKE', 'STRONG', 'SUB',
  'SUP', 'TIME', 'TT', 'U', 'VAR', 'WBR',
]);

export interface Run {
  nodes: Node[];
  parent: Element;
  /** Plain text, used for filtering only. */
  plain: string;
}

export interface ExtractOptions {
  exclude?: string;
  isProcessed?: (n: Node) => boolean;
}

/** Caches computed style lookups for one scan; layout-free (style only). */
export class StyleProbe {
  private display = new WeakMap<Element, string>();
  private block = new WeakMap<Element, boolean>();

  displayOf(el: Element): string {
    let d = this.display.get(el);
    if (d === undefined) {
      d = el.ownerDocument.defaultView?.getComputedStyle(el).display ?? '';
      if (!d) d = INLINE_TAGS.has(tagOf(el)) || ATOM_TAGS.has(tagOf(el)) ? 'inline' : 'block';
      this.display.set(el, d);
    }
    return d;
  }

  isHidden(el: Element): boolean {
    return this.displayOf(el) === 'none' || (el as HTMLElement).hidden === true;
  }

  isInline(el: Element): boolean {
    const d = this.displayOf(el);
    // Chrome computes inline MathML as `display: math` (block formulas are `block math`);
    // treating it as a block split Wikipedia sentences around every formula.
    return d.startsWith('inline') || d === 'contents' || d === 'math' || (d === 'ruby' && INLINE_TAGS.has(tagOf(el)));
  }

  /** Any visible non-inline descendant (an <a> wrapping a <div> card, etc.). */
  containsBlock(el: Element): boolean {
    let r = this.block.get(el);
    if (r === undefined) {
      r = false;
      for (const c of el.children) {
        if (this.isHidden(c) || ATOM_TAGS.has(tagOf(c))) continue;
        if (!this.isInline(c) || this.containsBlock(c)) {
          r = true;
          break;
        }
      }
      this.block.set(el, r);
    }
    return r;
  }
}

/** SVG and MathML elements report lowercase tagName ("svg"), HTML elements uppercase. */
const tagOf = (el: Element) => el.tagName.toUpperCase();

export function shouldSkip(el: Element, exclude?: string): boolean {
  if (SKIP_TAGS.has(tagOf(el))) return true;
  if (el.getAttribute('translate') === 'no') return true;
  if (el.classList.contains('notranslate')) return true;
  const ce = el.getAttribute('contenteditable');
  if (ce === '' || ce === 'true' || ce === 'plaintext-only') return true;
  if (el.hasAttribute('data-xt-skip')) return true;
  if (exclude) {
    try {
      if (el.matches(exclude)) return true;
    } catch {
      // invalid user selector: ignore
    }
  }
  return false;
}

/**
 * Collect translatable runs: maximal sequences of inline content directly
 * inside a block. A block that mixes text and child blocks yields several runs,
 * so nothing is translated twice.
 */
export function collectRuns(root: Element, opts: ExtractOptions = {}, probe = new StyleProbe()): Run[] {
  const runs: Run[] = [];
  const processed = opts.isProcessed ?? (() => false);

  const visit = (el: Element) => {
    if (shouldSkip(el, opts.exclude) || probe.isHidden(el)) return;
    let run: Node[] = [];
    const flush = () => {
      if (!run.length) return;
      const nodes = run;
      run = [];
      if (nodes.some(processed)) return;
      const plain = normalizeSpace(nodes.map((n) => n.textContent ?? '').join(''));
      if (isTranslatable(plain)) runs.push({ nodes, parent: el, plain });
    };
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        run.push(child);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const c = child as Element;
      if (OUR_TAGS.has(tagOf(c))) {
        flush();
        continue;
      }
      if (probe.isHidden(c)) {
        if (run.length) run.push(c);
        continue;
      }
      if (probe.isInline(c) && (!probe.containsBlock(c) || isFormula(c))) {
        // Inline but excluded (notranslate span, inline code) stays in the run as an atom.
        run.push(c);
        continue;
      }
      flush();
      visit(c);
    }
    flush();
  };

  visit(root);
  return runs;
}

/** Nearest ancestor that is not inline: the element whose runs must be rebuilt when inline content changes. */
export function blockAncestor(node: Node, probe: StyleProbe): Element | null {
  let el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  while (el && el !== el.ownerDocument.body && probe.isInline(el)) el = el.parentElement;
  return el;
}
