import { countLetters } from '../shared/text';

/** Semantic inline formatting worth keeping as a tag; the letter hints the model at its role. */
const WRAP_LETTER: Record<string, string> = {
  A: 'a',
  B: 'b',
  STRONG: 'b',
  EM: 'i',
  I: 'i',
  CITE: 'i',
  U: 'x',
  MARK: 'x',
  S: 'x',
  DEL: 'x',
  INS: 'x',
  SUB: 'x',
  SUP: 'x',
  Q: 'x',
};

/** Never translated; copied back verbatim as {{n}}. */
export const ATOM_TAGS = new Set([
  'CODE', 'KBD', 'SAMP', 'VAR', 'TT', 'IMG', 'SVG', 'MATH', 'BR', 'WBR', 'INPUT', 'BUTTON', 'SELECT',
  'TEXTAREA', 'VIDEO', 'AUDIO', 'CANVAS', 'PICTURE', 'IFRAME', 'OBJECT', 'EMBED', 'SCRIPT', 'STYLE',
  'NOSCRIPT', 'TEMPLATE',
]);

const FORMULA_SELECTOR = 'math, .katex, .MathJax, mjx-container, .mwe-math-element';

/**
 * Formula wrappers (Wikipedia's .mwe-math-element, KaTeX, MathJax) mix hidden
 * block-level a11y markup with images; they must stay one opaque inline atom.
 */
export function isFormula(el: Element): boolean {
  return el.matches(FORMULA_SELECTOR) || (el.tagName !== 'P' && !!el.querySelector?.(FORMULA_SELECTOR) && el.textContent!.length < 200);
}

export interface Serialized {
  text: string;
  /** `a1` → element to shallow-clone, `3` → node to deep-clone. */
  slots: Map<string, Node>;
  /**
   * Elements that wrapped the entire segment (a link-only commit message, a bold
   * heading). Models tend to drop such outer tags, so they are not sent at all and
   * are re-applied around the whole translation instead. Outermost first.
   */
  outer: Element[];
  /**
   * Leading / trailing pieces made only of code or icons (MDN's
   * "`IntersectionObserver.delay` Read only 🧪"). Not sent to the model, so the
   * bilingual line shows just "只读" instead of repeating the code name; replace
   * mode re-inserts them around the translation.
   */
  lead: string;
  trail: string;
}

// A token that carries no prose: an atom, or a tag wrapping only atoms/whitespace.
const BARE = String.raw`(?:\{\{\d+\}\}|<([a-z]\d+)>(?:\s|\{\{\d+\}\})*<\/\1>)`;
const LEAD_RE = new RegExp(String.raw`^(?:${BARE}\s*)+`);
const TRAIL_RE = new RegExp(String.raw`(?:\s*${BARE})+$`);

function peel(text: string): { lead: string; core: string; trail: string } {
  const lead = text.match(LEAD_RE)?.[0] ?? '';
  let core = text.slice(lead.length);
  const trail = core.match(TRAIL_RE)?.[0] ?? '';
  core = core.slice(0, core.length - trail.length);
  // Only peel when real prose remains; a line that is all code stays as it was.
  if (!/\p{L}{2,}/u.test(core.replace(/<\/?[a-z]\d+>|\{\{\d+\}\}/g, ''))) return { lead: '', core: text, trail: '' };
  return { lead: lead.trimEnd(), core: core.trim(), trail: trail.trimStart() };
}

export function serializeRun(nodes: Node[], isOpaque: (el: Element) => boolean = () => false): Serialized {
  const slots = new Map<string, Node>();
  let n = 0;

  const visit = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    const text = el.textContent ?? '';
    const hasMedia = !!el.querySelector?.('img,svg,video,canvas,picture');
    if (ATOM_TAGS.has(tag) || isOpaque(el) || isFormula(el) || (countLetters(text) === 0 && (text.trim() || hasMedia))) {
      // Elements without letters ("[1]" citations, icons) are atoms too.
      if (!text.trim() && !hasMedia && !ATOM_TAGS.has(tag)) return ' ';
      const id = String(++n);
      slots.set(id, el);
      return `{{${id}}}`;
    }
    const inner = [...el.childNodes].map(visit).join('');
    const letter = WRAP_LETTER[tag];
    if (!letter || !inner.trim()) return inner;
    const id = `${letter}${++n}`;
    slots.set(id, el);
    // Keep surrounding whitespace outside the tag so models see clean words.
    const lead = inner.match(/^\s*/)![0];
    const trail = inner.match(/\s*$/)![0];
    return `${lead}<${id}>${inner.trim()}</${id}>${trail}`;
  };

  let text = nodes
    .map(visit)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  const outer: Element[] = [];
  for (let m; (m = text.match(/^<([a-z]\d+)>([\s\S]*)<\/\1>$/)) && !m[2]!.includes(`<${m[1]}>`); ) {
    outer.push(slots.get(m[1]!) as Element);
    slots.delete(m[1]!);
    text = m[2]!.trim();
  }
  const { lead, core, trail } = peel(text);
  return { text: core, slots, outer, lead, trail };
}

// Digits are optional so sloppy closers like </a> (seen from DeepSeek) are consumed, not shown as text.
const TOKEN_RE = /<(\/?)([a-z])(\d*)>|\{\{(\d+)\}\}/g;

/**
 * Rebuild translated text into DOM. Text always becomes text nodes (no HTML
 * parsing, so model output can never inject markup). `exact` is false when
 * tags were missing, unbalanced or invented; the caller still gets a best-effort fragment.
 */
export function buildFragment(
  translation: string,
  slots: Map<string, Node>,
  doc: Document = document,
  outer: Element[] = [],
  peeled: { lead?: string; trail?: string } = {},
) {
  const used = new Set<string>();
  let exact = true;
  const root = doc.createDocumentFragment();

  const build = (translation: string, into: Node) => {
    const stack: { key: string; el: Node }[] = [];
    let last = 0;
    const top = () => stack[stack.length - 1];
    const parent = () => top()?.el ?? into;
    const pushText = (s: string) => {
      if (s) parent().appendChild(doc.createTextNode(s));
    };

    for (const m of translation.matchAll(TOKEN_RE)) {
      pushText(translation.slice(last, m.index));
      last = m.index! + m[0].length;
      if (m[4] !== undefined) {
        const node = slots.get(m[4]);
        if (node && !used.has(m[4])) {
          used.add(m[4]);
          parent().appendChild(node.cloneNode(true));
        } else exact = false;
        continue;
      }
      const isClose = m[1] === '/';
      if (!m[3]) {
        // Bare <a>/</a>: close the innermost open tag of the same kind, else drop it.
        exact = false;
        if (isClose && top()?.key.startsWith(m[2]!)) stack.pop();
        continue;
      }
      const key = `${m[2]}${m[3]}`;
      const node = slots.get(key);
      if (!node) {
        exact = false;
        continue;
      }
      if (!isClose) {
        if (used.has(key)) {
          exact = false;
          continue;
        }
        used.add(key);
        const clone = node.cloneNode(false) as Element;
        clone.removeAttribute?.('id');
        parent().appendChild(clone);
        stack.push({ key, el: clone });
      } else if (top()?.key === key) {
        stack.pop();
      } else {
        exact = false;
      }
    }
    pushText(translation.slice(last));
    if (stack.length) exact = false;
  };

  // Peeled code/icons live in <xt-peel>: hidden in bilingual mode, shown in replace mode.
  const peelEl = (tokens: string | undefined) => {
    if (!tokens) return null;
    const el = doc.createElement('xt-peel');
    build(tokens, el);
    return el;
  };
  const leadEl = peelEl(peeled.lead);
  if (leadEl) root.append(leadEl, ' ');
  build(translation, root);
  const trailEl = peelEl(peeled.trail);
  if (trailEl) root.append(' ', trailEl);
  if (used.size !== slots.size) exact = false;
  // Re-apply wrappers stripped by serializeRun, innermost last.
  let fragment = root;
  for (const el of [...outer].reverse()) {
    const clone = el.cloneNode(false) as Element;
    clone.removeAttribute('id');
    clone.append(fragment);
    fragment = doc.createDocumentFragment();
    fragment.append(clone);
  }
  return { fragment, exact };
}
