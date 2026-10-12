// Debug research aid: a page's structure without its content. Tags, roles and
// structural ARIA attributes are kept (id references renumbered), all text and
// labels become shape markers, URLs keep only well-known route words. Used to
// study how real apps build menus and settings without copying anything the
// user wrote. Debug builds only; output goes to the gitignored research/ folder.
import { OUR_TAGS } from '../shared/dom-tags';

const KEEP_ATTRS = ['role', 'aria-haspopup', 'aria-expanded', 'aria-current', 'aria-selected', 'aria-checked', 'aria-orientation', 'aria-modal', 'data-state', 'type', 'hidden', 'disabled', 'contenteditable'];
const REF_ATTRS = ['id', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'for'];
const MASK_ATTRS = ['aria-label', 'aria-description', 'placeholder', 'title', 'alt', 'value'];
const ROUTE_WORDS = new Set([
  'settings', 'customize', 'account', 'profile', 'billing', 'usage', 'general', 'privacy', 'security', 'notifications', 'members', 'team', 'teams',
  'org', 'orgs', 'workspace', 'workspaces', 'projects', 'project', 'chat', 'chats', 'new', 'sessions', 'session', 'integrations', 'connectors',
  'skills', 'plugins', 'api', 'keys', 'admin', 'help', 'docs', 'search', 'library', 'files', 'recents', 'home', 'dashboard', 'automations', 'review', 'wiki',
]);
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META']);

/** "Weekly sync notes" → ⟨Aa 3w⟩: capitalization and word count only. */
export function shape(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const words = t.split(' ').length;
  const cls = /^[A-Z]/.test(t) ? 'Aa' : /^[a-z]/.test(t) ? 'a' : /^\d/.test(t) ? '9' : /^[　-鿿]/.test(t) ? '字' : '·';
  return `⟨${cls} ${words}w⟩`;
}

function maskUrl(href: string, base: string): string {
  let u: URL;
  try {
    u = new URL(href, base);
  } catch {
    return '⟨url⟩';
  }
  const origin = u.origin === new URL(base).origin ? '' : '⟨external⟩';
  const path = u.pathname.split('/').map((s) => (!s || ROUTE_WORDS.has(s.toLowerCase()) ? s : ':seg')).join('/');
  const hash = u.hash ? '#' + u.hash.slice(1).split('/').map((s) => (ROUTE_WORDS.has(s.toLowerCase()) ? s : ':seg')).join('/') : '';
  return origin + path + (u.search ? '?…' : '') + hash;
}

/** Words that describe structure; anything else in a class or test id may be a name or a slug. */
const STRUCT_WORDS = new Set([
  ...ROUTE_WORDS, 'menu', 'button', 'btn', 'nav', 'sidebar', 'item', 'items', 'list', 'row', 'card', 'cards', 'grid', 'dialog', 'modal', 'header',
  'footer', 'trigger', 'content', 'panel', 'tab', 'tabs', 'user', 'avatar', 'pin', 'rows', 'recents', 'recent', 'toolbar', 'popover', 'tooltip',
  'title', 'label', 'icon', 'link', 'input', 'field', 'group', 'section', 'page', 'main', 'root', 'container', 'wrapper', 'option', 'options',
  'select', 'switch', 'toggle', 'close', 'open', 'more', 'primary', 'secondary', 'active', 'selected', 'disabled', 'hidden', 'composer',
]);
/** Tailwind-style utility classes: layout intent, never names. */
const UTILITY_RE =
  /^(?:[a-z]+:)*-?(?:flex|grid|block|inline|hidden|contents|absolute|relative|fixed|sticky|static|truncate|grow|shrink|isolate|sr-only|group|peer|container|(?:w|h|min-w|min-h|max-w|max-h|size|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y|inset|top|left|right|bottom|z|order|col|row|basis|text|font|leading|tracking|bg|border|rounded|shadow|ring|outline|opacity|overflow|items|justify|self|place|content|cursor|select|pointer-events|transition|duration|ease|translate|scale|rotate|origin|line-clamp|whitespace|break|object|aspect|fill|stroke)(?:-[\w./[\]%#-]+)?)$/;

/** Structural tokens kept; any other token becomes a placeholder. */
function maskTokens(value: string): string {
  return value
    .split(/([-_.])/)
    .map((t) => (/^[-_.]$/.test(t) || STRUCT_WORDS.has(t.toLowerCase()) ? t : t ? '⟨x⟩' : t))
    .join('');
}

/** Class names: utility classes kept as they are, other classes reduced to their structural words. */
function maskClass(cls: string): string {
  return cls
    .split(/\s+/)
    .filter((c) => c && c.length <= 40)
    .slice(0, 8)
    .map((c) => (UTILITY_RE.test(c) && !/[0-9a-f]{6,}/i.test(c) ? c : maskTokens(c)))
    .join('.');
}

export function skeleton(root: Element, opts: { maxNodes?: number } = {}): string {
  const max = opts.maxNodes ?? 4000;
  const base = root.ownerDocument.location?.href ?? 'https://example.invalid/';
  const ids = new Map<string, string>();
  const ref = (id: string) => ids.get(id) ?? ids.set(id, `r${ids.size + 1}`).get(id)!;
  const out: string[] = [];
  let count = 0;
  const walk = (el: Element, depth: number) => {
    if (count++ >= max || SKIP.has(el.tagName) || OUR_TAGS.has(el.tagName)) return;
    const parts = [el.tagName.toLowerCase()];
    for (const a of KEEP_ATTRS) {
      const v = el.getAttribute(a);
      if (v !== null) parts.push(v === '' ? `[${a}]` : `[${a}=${v.slice(0, 20)}]`);
    }
    for (const a of REF_ATTRS) {
      const v = el.getAttribute(a);
      if (v) parts.push(`[${a}=${v.split(/\s+/).map(ref).join(' ')}]`);
    }
    for (const a of MASK_ATTRS) {
      const v = el.getAttribute(a);
      if (v) parts.push(`[${a}=${shape(v)}]`);
    }
    const testid = el.getAttribute('data-testid');
    if (testid) parts.push(`[data-testid=${/\d{2,}|@|[0-9a-f]{8}/i.test(testid) ? '⟨id⟩' : maskTokens(testid.slice(0, 60))}]`);
    const href = el.getAttribute('href');
    if (href) parts.push(`[href=${maskUrl(href, base)}]`);
    const cls = typeof el.className === 'string' ? maskClass(el.className) : '';
    if (cls) parts.push(`.${cls}`);
    const text = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.nodeValue ?? '').join(' ');
    const s = shape(text);
    if (s) parts.push(s);
    if (el.tagName === 'svg' || el.tagName === 'SVG') {
      out.push('  '.repeat(depth) + parts.join(''));
      return;
    }
    out.push('  '.repeat(depth) + parts.join(''));
    for (const c of el.children) walk(c, depth + 1);
    const shadow = (el as HTMLElement).shadowRoot;
    if (shadow) for (const c of shadow.children) walk(c, depth + 1);
  };
  walk(root, 0);
  if (count > max) out.push(`… (truncated at ${max} elements)`);
  return out.join('\n');
}
