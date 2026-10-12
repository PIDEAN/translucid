// Stable CSS selectors for user-picked UI regions. Prefer meaning (test ids,
// ARIA, landmarks, readable ids and classes) over position, so a region keeps
// matching after the app re-renders; never use hashed class names or long
// nth-child chains. Labels shown to the user never quote page text that could
// be personal.
import { hasContactData } from './hardflags';
import { idLikeSegment, textFlags } from './privacy';

const TEST_ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy'];
const LANDMARK_TAGS = new Set(['NAV', 'ASIDE', 'HEADER', 'FOOTER', 'MAIN', 'DIALOG', 'MENU', 'FORM', 'FIELDSET']);
const ROLE_LABELS: Record<string, string> = {
  navigation: '导航', banner: '顶栏', complementary: '侧栏', contentinfo: '页脚', main: '主区域', dialog: '对话框',
  alertdialog: '对话框', menu: '菜单', menubar: '菜单栏', toolbar: '工具栏', tablist: '标签栏', search: '搜索', form: '表单',
};
const TAG_LABELS: Record<string, string> = { NAV: '导航', ASIDE: '侧栏', HEADER: '顶栏', FOOTER: '页脚', MAIN: '主区域', DIALOG: '对话框', MENU: '菜单', FORM: '表单', FIELDSET: '输入区' };

const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, (c) => `\\${c}`));
const attrSel = (name: string, value: string) => `[${name}="${value.replace(/["\\]/g, '\\$&')}"]`;

// Tailwind-style utility classes describe looks, not meaning: they repeat everywhere and change with redesigns.
const UTILITY_RE =
  /^-?(flex|grid|block|inline|hidden|contents|absolute|relative|fixed|sticky|static|truncate|group|peer|isolate|container|w|h|min|max|size|p[trblxyse]?|m[trblxyse]?|gap|space|text|bg|from|via|to|border|rounded|shadow|ring|outline|font|leading|tracking|items|justify|content|self|place|overflow|overscroll|z|top|left|right|bottom|inset|opacity|transition|duration|delay|ease|animate|transform|scale|rotate|translate|skew|origin|cursor|select|pointer|touch|shrink|grow|basis|order|col|row|auto|divide|fill|stroke|object|aspect|whitespace|break|line|list|decoration|underline|uppercase|lowercase|capitalize|italic|antialiased|backdrop|blur|filter|invisible|visible|sr|not|hover|focus|active|disabled|dark|light|sm|md|lg|xl|2xl|motion|draggable|will|appearance|resize|scroll|snap|table|float|clear|box|align|indent|tabular|lining|ordinal|slashed|diagonal|stacked|proportional|normal)(-|$)/;

/** Class names that are semantic, not generated (css-1x2y3z, _a1b2c, sc-hash) or utility classes. */
function readableClass(c: string): boolean {
  if (c.length < 3 || c.length > 32) return false;
  if (/\d/.test(c) || /[:[\]/!@.]/.test(c)) return false;
  if (/^(css|sc|jsx|emotion|svelte)-/i.test(c) || /^_/.test(c)) return false;
  if (UTILITY_RE.test(c)) return false;
  return /^[a-zA-Z][a-zA-Z-]+$/.test(c);
}

/** Ids generated per render or per build (React useId `_r_1_`/`:r1:`/`«r1»`, Radix, Headless UI, Base UI, MUI). */
function stableId(id: string): boolean {
  if (!id || idLikeSegment(id)) return false;
  if (/\d|^_|_$|[:«»]/.test(id)) return false;
  return !/^(radix|headlessui|base-ui|mui|react-aria|rc|aria|id|uid|ember|vue|ng|svelte)-/i.test(id);
}

const cleanLabel = (v: string | null): v is string => !!v && v.length <= 40 && textFlags(v).length === 0;

/** The single most meaningful selector for this element alone, or undefined. */
function ownSelector(el: Element): string | undefined {
  for (const a of TEST_ATTRS) {
    const v = el.getAttribute(a);
    // A test id that names a person or carries contact data never becomes a stored selector.
    if (v && !idLikeSegment(v) && !hasContactData(v) && !textFlags(v).includes('possible-name')) return attrSel(a, v);
  }
  if (stableId(el.id)) return `#${esc(el.id)}`;
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role');
  const label = el.getAttribute('aria-label');
  if (role && cleanLabel(label)) return `${attrSel('role', role)}${attrSel('aria-label', label)}`;
  if (LANDMARK_TAGS.has(el.tagName) && cleanLabel(label)) return `${tag}${attrSel('aria-label', label)}`;
  if (role && ROLE_LABELS[role]) return attrSel('role', role);
  if (LANDMARK_TAGS.has(el.tagName)) return tag;
  const cls = [...el.classList].filter(readableClass).slice(0, 2);
  if (cls.length) return `${tag}.${cls.map(esc).join('.')}`;
  return undefined;
}

function matchesOnly(doc: Document | ShadowRoot, sel: string, el: Element, max: number): boolean {
  try {
    const all = doc.querySelectorAll(sel);
    return all.length > 0 && all.length <= max && [...all].includes(el);
  } catch {
    return false;
  }
}

/**
 * Selector for `el`: its own meaningful selector if unique enough, otherwise
 * the nearest meaningful ancestor plus this element's own selector (or, as a
 * last resort, one :nth-of-type step). Returns undefined if nothing stable exists.
 */
export function buildSelector(el: Element, maxMatches = 3): string | undefined {
  const root = el.getRootNode() as Document | ShadowRoot;
  const own = ownSelector(el);
  if (own && matchesOnly(root, own, el, maxMatches)) return own;
  for (let a = el.parentElement, depth = 0; a && depth < 6; a = a.parentElement, depth++) {
    const anchor = ownSelector(a);
    if (!anchor) continue;
    const tail = own ?? `${el.tagName.toLowerCase()}`;
    for (const sel of [`${anchor} ${tail}`, `${anchor} > ${tail}`]) {
      if (matchesOnly(root, sel, el, maxMatches)) return sel;
    }
    const siblings = el.parentElement ? [...el.parentElement.children].filter((c) => c.tagName === el.tagName) : [];
    const nth = `${anchor} ${el.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(el) + 1})`;
    if (siblings.length > 1 && matchesOnly(root, nth, el, 1)) return nth;
  }
  return own && matchesOnly(root, own, el, 20) ? own : undefined;
}

/** Human label for a region, built from structure, never from page content. */
export function regionLabel(el: Element): string {
  const role = el.getAttribute('role');
  const label = el.getAttribute('aria-label');
  // A bare tag name (span, div) means nothing to the user: call it an area.
  const base = (role && ROLE_LABELS[role]) || TAG_LABELS[el.tagName] || '区域';
  return cleanLabel(label) ? `${base}（${label}）` : base;
}
