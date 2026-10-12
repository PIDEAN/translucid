// Interface or content? Decides, per string occurrence, whether it is UI chrome
// worth translating (and how confident we are), or something the user wrote or
// owns, which is never stored. Precedence, highest first:
//   1. hard privacy flags (emails, links to one item, handles…)  → dropped
//   2. user excludes                                           → handled by the walk (skipped)
//   3. content containers (editors, transcripts, documents)    → content (control labels excepted)
//   4. the account area (avatar/initials trigger and its menu) → content, menu items excepted
//   5. user item lists (rows/cards with a per-row action menu,
//      an avatar or a timestamp; one or two cards count too)  → content (repeated labels excepted)
//   6. interface signals (roles, surfaces, landmarks, groups)  → high, otherwise uncertain
import { ATTR_KINDS, normalizeKey, type EntryKind } from './format';
import { CONTROL_SELECTOR as CONTENT_CONTROL, USER_CONTENT_SELECTOR } from './dom-rules';
import { FLAG_LABELS, hrefLooksPersonal, isHardFlagged, textFlags, type PrivacyFlag } from './privacy';
import { navCollectionOf, originalText, rowControlFor, surfaceOf, triggerOf } from './structure';

export type Tier = 'high' | 'uncertain' | 'content';

export interface Verdict {
  tier: Tier;
  /** Why it is not 'high' (shown in the review list). */
  reason?: string;
  flags: PrivacyFlag[];
}

export const CONTENT_CONTAINER = [
  USER_CONTENT_SELECTOR,
  '[role="feed"]', '[role="document"]', '[contenteditable]:not([contenteditable="false"])', '.ProseMirror', '.cm-editor', '.monaco-editor',
].join(',');
const CONTROL = 'button,a[href],[role="button"],[role="link"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="tab"],[role="option"],[role="switch"],[role="checkbox"],[role="radio"],[role="combobox"],summary,label';
const MENU_ITEM = '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],a[href],button,[role="option"]';
const LANDMARK = 'nav,aside,header,footer,[role="navigation"],[role="banner"],[role="complementary"],[role="toolbar"],[role="tablist"],[role="menubar"]';
const SURFACE = '[role="dialog"],[role="alertdialog"],dialog[open],[role="menu"],[role="listbox"],[role="tooltip"],[data-radix-popper-content-wrapper]';
const ROW_BOUNDARY =
  'body,main,[role="main"],[role="dialog"],[role="alertdialog"],dialog,[role="menu"],[role="listbox"],[role="radiogroup"],[role="tablist"],[role="toolbar"],nav,[role="navigation"],aside,header,footer,form,fieldset,[role="group"]';
/** Structures a single item card never contains (a container holding these is a section, not a card). */
const CARD_BLOCKERS = 'form,fieldset,nav,main,aside,header,footer,[role="dialog"],[role="menu"],[role="navigation"],[role="tablist"],[role="toolbar"]';
const ROW_TAGS = 'li,tr,article,[role="row"],[role="listitem"],[role="article"],[role="gridcell"]';

const ACCOUNT_RE = /(^|[\s_-])(account|profile|user[\s_-]?menu|avatar|my account|switch (team|organi[sz]ation|workspace))($|[\s_-])/i;
const ACTION_MENU_RE = /\b(more|options|actions|menu)\b|…|⋯|\.\.\./i;
const RELATIVE_TIME_RE =
  /\b(\d+\s*(?:s|m|h|d|w|mo|y|sec|secs|min|mins|minutes?|hours?|hrs?|days?|weeks?|months?|years?)\s+ago|yesterday|today|just now|last (?:week|month|year)|edited)\b/i;
const INITIALS_RE = /^[A-Z]{1,3}$/;
/** URL words after which the next path segment names something the user owns (an org, team, project). */
const OWNER_WORDS = new Set(['org', 'orgs', 'organization', 'organizations', 'team', 'teams', 'workspace', 'workspaces', 'w', 'u', 'user', 'users', 'company', 'space', 'spaces', 'project', 'projects']);
/** Route words: a segment like these after an owner word is a page, not a name (/projects/new, /team/settings). */
const ROUTE_WORDS = new Set([
  'new', 'settings', 'preferences', 'profile', 'security', 'billing', 'members', 'general', 'account', 'notifications', 'integrations', 'api',
  'keys', 'usage', 'plans', 'admin', 'overview', 'all', 'archive', 'archived', 'recent', 'shared', 'templates', 'import', 'export', 'search',
]);
/** Soft flags that leave a string unchecked; the rest of the non-hard flags mean "nothing to translate". */
const DROP_FLAGS: ReadonlySet<PrivacyFlag> = new Set(['no-letters', 'already-target']);

const labelOf = (el: Element) => (el.getAttribute('aria-label') ?? originalText(el)).replace(/\s+/g, ' ').trim();

/** A button or popup trigger that represents the signed-in user (avatar, initials, "Account"). */
export function isAccountTrigger(el: Element): boolean {
  if (!el.matches('button,[role="button"],[aria-haspopup]')) return false;
  const hints = [el.getAttribute('aria-label'), el.getAttribute('data-testid'), el.id, typeof el.className === 'string' ? el.className : ''].join(' ');
  if (ACCOUNT_RE.test(hints)) return true;
  if (!el.hasAttribute('aria-haspopup')) return false;
  if (el.querySelector('img,[class*="avatar" i],[data-testid*="avatar" i]')) return true;
  return [...el.querySelectorAll('span,div')].some((c) => !c.children.length && INITIALS_RE.test((c.textContent ?? '').trim()));
}

/** The account trigger `el` sits in (or that opened the popup `el` sits in). */
export function accountArea(el: Element): { trigger: Element; inMenu: boolean } | undefined {
  for (let a: Element | null = el, d = 0; a && d < 5; a = a.parentElement, d++) {
    if (isAccountTrigger(a)) return { trigger: a, inMenu: false };
  }
  // Account menus are menus (or popovers); dialogs and listboxes are not checked (cheap, and never account menus).
  const surface = el.closest('[role="menu"],[data-radix-popper-content-wrapper]');
  if (surface) {
    const t = triggerOf(surface);
    if (t && isAccountTrigger(t)) return { trigger: t, inMenu: true };
  }
  return undefined;
}

const ACTION_MENU = 'button[aria-haspopup="menu"],button[aria-haspopup="true"],[role="button"][aria-haspopup="menu"]';

/** A per-item "More options" menu button (icon only, or labelled like one). */
function isActionMenu(b: Element): boolean {
  if (isAccountTrigger(b)) return false;
  const label = labelOf(b);
  return !label || ACTION_MENU_RE.test(label);
}

function hasActionMenu(row: Element, el: Element): boolean {
  for (const b of row.querySelectorAll(ACTION_MENU)) if (!b.contains(el) && isActionMenu(b)) return true;
  return false;
}

/** The action menu button `el` is (or is inside). */
const ownActionMenu = (el: Element) => {
  const b = el.closest(ACTION_MENU);
  return b && isActionMenu(b) ? b : null;
};

const hasAvatar = (row: Element) => !!row.querySelector('img,[class*="avatar" i],[data-testid*="avatar" i]');

function hasTimestamp(row: Element): boolean {
  if (row.querySelector('time')) return true;
  const w = row.ownerDocument.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(), i = 0; n && i < 40; n = w.nextNode(), i++) {
    const t = (n.nodeValue ?? '').trim();
    if (t && (RELATIVE_TIME_RE.test(t) || textFlags(t).includes('date'))) return true;
  }
  return false;
}

/** Elements that look like `row`: same tag and at least one shared class or data attribute. */
function similarSiblings(row: Element): Element[] {
  const parent = row.parentElement;
  if (!parent) return [];
  const sig = (e: Element) => [e.tagName, e.getAttribute('role') ?? '', ...[...e.attributes].filter((a) => a.name.startsWith('data-')).map((a) => a.name).sort()].join('|');
  const classes = new Set((row.getAttribute('class') ?? '').split(/\s+/).filter(Boolean));
  const mine = sig(row);
  return [...parent.children].filter(
    (c) => c !== row && c.tagName === row.tagName && (sig(c) === mine || (c.getAttribute('class') ?? '').split(/\s+/).some((x) => classes.has(x))),
  );
}

/**
 * The user-item row or card `el` belongs to: a list item (or an element with
 * look-alike siblings) carrying a per-row action menu, an avatar or a
 * timestamp. Navigation collections and option lists never count.
 */
export function userRowOf(el: Element): Element | undefined {
  if (navCollectionOf(el)) return undefined;
  for (let a = el.parentElement, d = 0; a && d < 6; a = a.parentElement, d++) {
    if (a.matches(ROW_BOUNDARY)) return undefined;
    const controls = a.querySelectorAll(CONTROL).length;
    if (controls > 6) continue;
    const menu = hasActionMenu(a, el);
    // A lone card with its own "More options" menu is an item too (no look-alike siblings needed);
    // a small option group inside it is still the card's, a form or navigation is not, and a
    // container with several such menus is a list of cards, not one.
    if (menu && controls <= 4 && !a.querySelector(CARD_BLOCKERS) && [...a.querySelectorAll(ACTION_MENU)].filter(isActionMenu).length === 1) return a;
    const rowLike = a.matches(ROW_TAGS) || similarSiblings(a).length > 0;
    if (!rowLike) continue;
    if (menu || hasAvatar(a) || hasTimestamp(a)) return a;
  }
  return undefined;
}

/** Does `src` appear in at least one other row like `row`? (Labels repeated per row are UI: "More options", "Connected".) */
function repeatedInRows(row: Element, src: string): boolean {
  return similarSiblings(row).some((r) => {
    const w = r.ownerDocument.createTreeWalker(r, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE ? normalizeKey(originalText(n)) === src : ATTR_KINDS.some((k) => normalizeKey((n as Element).getAttribute(k) ?? '') === src)) {
        return true;
      }
    }
    return false;
  });
}

/** Text equal to the path segment after an owner word (/org/acme → "Acme") or to a tenant subdomain. */
export function namesUrlOwner(src: string, loc: Location | undefined): boolean {
  if (!loc) return false;
  const c = src.toLowerCase().replace(/[\s_]+/g, '-');
  const segs = loc.pathname.split('/').filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s).toLowerCase();
    } catch {
      return s.toLowerCase();
    }
  });
  for (let i = 0; i + 1 < segs.length; i++) if (OWNER_WORDS.has(segs[i]!) && segs[i + 1] === c && !ROUTE_WORDS.has(c)) return true;
  const labels = loc.hostname.split('.');
  return labels.length >= 3 && !['www', 'app', 'web', 'beta', 'staging'].includes(labels[0]!) && labels[0] === c;
}

const isAttrKind = (kind: EntryKind) => kind !== 'text';

/** Strong interface signals for a text occurrence. */
function uiSignal(el: Element): boolean {
  if (el.closest(CONTROL) || el.closest('select')) return true;
  // The title or description of a settings row ("Display density / How much space…" | control).
  if (rowControlFor(el)) return true;
  if (el.closest('h1,h2,h3,h4,h5,h6,[role="heading"],legend,th,[role="columnheader"],caption,dt')) return true;
  if (el.closest(SURFACE) || el.closest(LANDMARK)) return true;
  if (el.closest('[role="group"],[role="radiogroup"],fieldset')) return true;
  // Referenced as a label or description by a control.
  const id = el.id || el.closest('[id]')?.id;
  if (id && el.ownerDocument.querySelector(`[aria-labelledby~="${CSS.escape(id)}"],[aria-describedby~="${CSS.escape(id)}"],label[for="${CSS.escape(id)}"]`)) return true;
  return false;
}

/**
 * Classify one occurrence. `el` is the element holding the text (or carrying the
 * attribute). Returns null for strings to drop entirely (hard flags, nothing to
 * translate).
 */
export function classify(el: Element, kind: EntryKind, src: string, targetLang: string): Verdict | null {
  const flags = textFlags(src, targetLang);
  const link = el.closest('a[href]');
  if (link && hrefLooksPersonal(link.getAttribute('href')!, el.ownerDocument.location?.href)) flags.push('personal-link');
  if (isHardFlagged(flags) || flags.some((f) => DROP_FLAGS.has(f))) return null;
  const v = (tier: Tier, reason?: string): Verdict => ({ tier, ...(reason ? { reason } : {}), flags });
  const soft = flags.filter((f) => f !== 'identifier' || kind === 'text');

  const boundary = contentBoundary(el, kind, src, flags);
  if (boundary) return v(boundary.tier, boundary.reason);

  // Long native option lists are usually the user's own things (repositories, people, projects).
  const sel = el.closest('select');
  if (sel && sel.querySelectorAll('option').length > 25) return v('uncertain', '很长的选项列表，可能是你的数据');

  // 6. Interface signals.
  if (soft.length) return v('uncertain', soft.map((f) => FLAG_LABELS[f]).join('、'));
  if (isAttrKind(kind)) return v('high');
  if (uiSignal(el)) return v('high');
  const s = surfaceOf(el);
  if (s.kind !== 'page') return v('high');
  return v('uncertain', '页面中的普通文字');
}

/** The content boundaries shared by collection and application. */
function contentBoundary(el: Element, kind: EntryKind, src: string, flags: PrivacyFlag[]): Pick<Verdict, 'tier' | 'reason'> | undefined {
  const v = (tier: Tier, reason?: string) => ({ tier, ...(reason ? { reason } : {}) });
  // 3. Content containers: only control labels survive.
  const container = el.closest(CONTENT_CONTAINER);
  if (container) {
    const control = el.closest(CONTENT_CONTROL);
    if (!control || !container.contains(control)) return v('content', '位于正文或编辑器中');
    if (isAttrKind(kind)) return flags.some((f) => f !== 'identifier') ? v('uncertain', flags.map((f) => FLAG_LABELS[f]).join('、')) : v('high');
    return v('uncertain', '正文中的按钮文字');
  }

  // 4. Account area.
  const account = accountArea(el);
  if (account && !account.inMenu) return v('content', '账户按钮上的名字或头像');
  if (account?.inMenu) {
    if (!el.closest(MENU_ITEM) || flags.includes('possible-name') || flags.includes('names')) return v('content', '账户菜单中的个人信息');
  }

  // Organization or project names repeated from the address (/org/acme → "Acme").
  if (namesUrlOwner(src, el.ownerDocument.location)) return v('content', '与网址中的组织或项目名相同');

  // Table data: values of rows (names, emails, amounts) are content; a value repeated down a column
  // ("Member", "Active") may be interface. Column headers are interface.
  const cell = el.closest('td,[role="cell"],[role="gridcell"]');
  if (cell && !el.closest('th,[role="columnheader"],[role="rowheader"]')) {
    const tr = cell.closest('tr,[role="row"]');
    const table = tr?.closest('table,[role="table"],[role="grid"],[role="treegrid"]');
    const rows = table ? [...table.querySelectorAll('tbody tr,[role="rowgroup"] [role="row"]')].filter((r) => r !== tr) : [];
    const repeated = rows.some((r) => [...r.querySelectorAll('td,[role="cell"],[role="gridcell"]')].some((c) => normalizeKey(originalText(c)) === src));
    if (repeated && (el.closest(CONTROL) || isAttrKind(kind))) return v('high');
    if (repeated && src.split(/\s+/).length <= 3) return v('uncertain', '表格中多行重复出现');
    return v('content', '表格里的数据');
  }

  // 5. User item lists: only what every row repeats ("More options", "Connected") or the row's
  // own action-menu label is interface; titles, descriptions and per-row buttons are the user's.
  const row = userRowOf(el);
  if (row) {
    if (ownActionMenu(el)) return v('high');
    const repeated = repeatedInRows(row, src);
    if (repeated && (isAttrKind(kind) || el.closest(CONTROL))) return v('high');
    if (repeated && src.split(/\s+/).length <= 3) return v('uncertain', '列表中每行都出现');
    return v('content', '像用户自己的条目（会话、文件、项目）');
  }
}

/** Even an approved translation must never rewrite user content. */
export function contentAt(el: Element, kind: EntryKind, src: string): boolean {
  const flags = textFlags(src);
  const link = el.closest('a[href]');
  if (link && hrefLooksPersonal(link.getAttribute('href')!, el.ownerDocument.location?.href)) return true;
  return isHardFlagged(flags) || contentBoundary(el, kind, src, flags)?.tier === 'content';
}
