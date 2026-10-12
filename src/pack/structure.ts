// Semantic structure of an app's interface, read from ARIA first and simple
// heuristics second: which surface (page, dialog, menu, popover, listbox) a
// string lives on, which section (active nav item, tab or heading) and which
// group (a question with its options, a menu, a toolbar). The structure gives
// the model the context it needs ("Engineering" answers "What best describes
// your work?") and yields a context signature so one source string can carry
// different translations ("Medium" text size vs "Medium" width).
//
// Labels are read in the source language even after the page was translated
// (registry originals). Runtime ids (React useId) are used to resolve
// references but never stored.
import type { EntryKind } from './format';
import { textFlags, hrefLooksPersonal } from './privacy';
import { originalAttr, originalData } from './registry';

export type SurfaceKind = 'page' | 'dialog' | 'menu' | 'popover' | 'listbox' | 'drawer';
export type GroupRole = 'radiogroup' | 'group' | 'select' | 'field' | 'listbox' | 'menu' | 'tablist' | 'toolbar' | 'nav';
export type ItemRole =
  | 'button' | 'link' | 'tab' | 'menuitem' | 'option' | 'radio' | 'switch' | 'checkbox' | 'heading' | 'label' | 'legend'
  | 'description' | 'value' | 'placeholder' | 'tooltip' | 'aria-label' | 'image' | 'text';

export interface Where {
  surface: { kind: SurfaceKind; label?: string };
  section?: string;
  group?: { role: GroupRole; label?: string };
  role: ItemRole;
}

export const SURFACE_SELECTOR =
  '[role="dialog"],[role="alertdialog"],dialog[open],[role="menu"],[role="menubar"],[role="listbox"],[data-radix-popper-content-wrapper]';
const GROUP_SELECTOR = '[role="radiogroup"],[role="group"],fieldset,[role="listbox"],[role="menu"],[role="menubar"],[role="tablist"],[role="toolbar"]';
export const CONTROL_SELECTOR = 'button,a[href],[role="button"],[role="tab"],[role="link"],[role="menuitem"]';
export const ACTIVE_SELECTOR =
  '[aria-current]:not([aria-current="false"]),[role="tab"][aria-selected="true"],[data-state="active"],[aria-selected="true"]';
export const COLLECTION_SELECTOR = 'ul,ol,nav,aside,[role="tablist"],[role="list"],[role="navigation"],[role="complementary"]';
/** Roots of single settings controls, whose question may be written beside them instead of in ARIA. */
const CONTROL_ROOT =
  '[role="radiogroup"],[role="switch"],[role="checkbox"],[role="combobox"],[role="slider"],select,input:not([type="hidden"]),textarea,button[aria-haspopup]:not([aria-haspopup="false"]),[role="button"][aria-haspopup]:not([aria-haspopup="false"])';
const ANY_CONTROL =
  'button,a[href],[role="button"],[role="tab"],[role="link"],[role="menuitem"],input,select,textarea,[role="switch"],[role="checkbox"],[role="radio"],[role="radiogroup"],[role="combobox"],[role="slider"]';
const ROW_STOP = '[role="dialog"],[role="alertdialog"],dialog,[role="menu"],[role="listbox"],main,body,nav,aside,header,footer,form,[role="group"],[role="radiogroup"],fieldset';
const MAX_LABEL = 80;

const clean = (s: string | null | undefined): string | undefined => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  // Labels that look personal never become context (they would leak into prompts and signatures).
  if (textFlags(t).some((f) => f !== 'identifier')) return undefined;
  return t.slice(0, MAX_LABEL);
};

const rootOf = (el: Element): Document | ShadowRoot => el.getRootNode() as Document | ShadowRoot;

/** Original text of an element without aria-hidden decorations (icons, bullets). */
export function originalText(el: Node): string {
  if (el.nodeType === Node.TEXT_NODE) return originalData(el);
  const doc = el.ownerDocument;
  if (!doc) return el.textContent ?? '';
  let out = '';
  const w = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) =>
      n.nodeType === Node.ELEMENT_NODE && (n as Element).getAttribute('aria-hidden') === 'true' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeType === Node.TEXT_NODE) out += originalData(n);
  return out;
}

/** Text of the elements an aria-labelledby / aria-describedby attribute points to (originals). */
function referenced(el: Element, attr: string): string | undefined {
  const ids = (originalAttr(el, attr) ?? '').split(/\s+/).filter(Boolean);
  if (!ids.length) return undefined;
  const root = rootOf(el);
  const text = ids
    .map((id) => (root as Document).getElementById?.(id) ?? el.ownerDocument.getElementById(id))
    .filter((x): x is HTMLElement => !!x && x !== el && !x.contains(el))
    .map((x) => originalText(x))
    .join(' ');
  return clean(text);
}

/** Label of a group container: aria-labelledby, aria-label, legend, label[for], short leading text. */
export function groupLabel(g: Element): string | undefined {
  const by = referenced(g, 'aria-labelledby');
  if (by) return by;
  const aria = clean(originalAttr(g, 'aria-label'));
  if (aria) return aria;
  const legend = g.querySelector(':scope > legend');
  if (legend) return clean(originalText(legend));
  // Option containers (listbox, menu, radiogroup…) list their options first: no visual-label heuristic there.
  if (!(g.getAttribute('role') === 'group' || g.tagName === 'FIELDSET')) return undefined;
  // First short text child that contains no controls (a visual label row).
  for (const c of g.children) {
    if (c.matches(CONTROL_SELECTOR) || c.querySelector(CONTROL_SELECTOR + ',input,select,textarea,[role="switch"],[role="radio"],[role="combobox"]')) break;
    const t = originalText(c).trim();
    if (t && t.length <= 60) return clean(t);
  }
  return undefined;
}

function surfaceKind(el: Element): SurfaceKind {
  const role = el.getAttribute('role');
  if (role === 'menu' || role === 'menubar') return 'menu';
  if (role === 'listbox') return 'listbox';
  if (el.hasAttribute('data-radix-popper-content-wrapper')) return 'popover';
  return 'dialog';
}

export interface SurfaceInfo {
  el: Element | null;
  kind: SurfaceKind;
  label?: string;
}

/** The surface an element lives on (nearest dialog/menu/listbox/popover, else the page). */
export function surfaceOf(el: Element): SurfaceInfo {
  const s = el.closest(SURFACE_SELECTOR);
  if (!s) return { el: null, kind: 'page' };
  const kind = surfaceKind(s);
  // A popup is named by the question its trigger answers ("Chat font"), not by the trigger's
  // current value ("Serif"), which Radix and Base UI often use as aria-labelledby.
  const trigger = kind !== 'dialog' ? triggerOf(s) : null;
  let label = trigger
    ? (groupOf(trigger, surfaceOf(trigger))?.label ?? controlLabel(trigger))
    : (referenced(s, 'aria-labelledby') ?? clean(originalAttr(s, 'aria-label')));
  if (!label && !trigger) label = referenced(s, 'aria-labelledby') ?? clean(originalAttr(s, 'aria-label'));
  if (!label && kind === 'dialog') {
    const h = s.querySelector('h1,h2,h3,[role="heading"]');
    if (h) label = clean(originalText(h));
  }
  return { el: s, kind, label };
}

/** Accessible name of a control (original text or aria-label). */
export function controlLabel(el: Element): string | undefined {
  return clean(originalAttr(el, 'aria-label')) ?? referenced(el, 'aria-labelledby') ?? clean(originalText(el));
}

/**
 * The trigger that opened a popup surface: aria-controls pointing at it, else
 * the (last) expanded popup trigger in the document. Works without aria-controls,
 * which Base UI / Radix portals often omit.
 */
export function triggerOf(surface: Element): Element | null {
  const doc = surface.ownerDocument;
  if (surface.id) {
    const byControls = doc.querySelector(`[aria-controls="${CSS.escape(surface.id)}"]`);
    if (byControls) return byControls;
  }
  const expanded = [...doc.querySelectorAll('[aria-expanded="true"][aria-haspopup]:not([aria-haspopup="false"]),[role="combobox"][aria-expanded="true"]')]
    .filter((t) => !surface.contains(t));
  return expanded.at(-1) ?? null;
}

/**
 * A navigation collection: a container with 3+ controls of which exactly one is
 * current/selected/active. Covers buttons that are cousins under ul > li (the
 * Claude settings nav), tablists and hub link lists outside <nav>.
 */
export function navCollectionOf(item: Element): { container: Element; active: Element } | undefined {
  for (let c = item.parentElement, depth = 0; c && depth < 4; c = c.parentElement, depth++) {
    if (!c.matches(COLLECTION_SELECTOR)) continue;
    const controls = [...c.querySelectorAll(CONTROL_SELECTOR)];
    if (controls.length < 3) continue;
    const active = controls.filter((x) => x.matches(ACTIVE_SELECTOR));
    if (active.length === 1) return { container: c, active: active[0]! };
  }
  return undefined;
}

/**
 * Section of `el` inside its surface. In a dialog: the active item of its navigation (the settings
 * tab being shown), else the nearest preceding heading. On a page the nearest heading is the finer
 * section, and the active item of the page's navigation (the page itself) is the fallback.
 */
export function sectionOf(el: Element, surface: SurfaceInfo): string | undefined {
  if (surface.kind === 'page') return headingSection(el, surface) ?? navSection(el, surface);
  return navSection(el, surface) ?? headingSection(el, surface);
}

function navSection(el: Element, surface: SurfaceInfo): string | undefined {
  const scope: ParentNode = surface.el ?? el.ownerDocument;
  for (const active of scope.querySelectorAll(ACTIVE_SELECTOR)) {
    if (!active.matches(CONTROL_SELECTOR)) continue;
    const nav = navCollectionOf(active);
    // The element inside the nav itself is a nav item, not content of a section; and a nav only
    // governs what follows it (tabs further down do not make the main nav part of a tab).
    if (!nav || nav.container.contains(el)) continue;
    if (!(nav.container.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    // A selected chat in a sidebar would make the section a chat title: never use personal links.
    const href = active.getAttribute('href');
    if (href && hrefLooksPersonal(href, el.ownerDocument.location?.href)) continue;
    const label = controlLabel(nav.active);
    if (label) return label;
  }
  return undefined;
}

const HEADING = 'h1,h2,h3,[role="heading"]';
/** Headings looked for inside a preceding sibling (the first match wins). */
const HEADING_IN = 'h1,h2,h3,[role="heading"]:last-of-type';
/** Hidden by markup: tab panels and settings sections that stay in the DOM while another one shows. */
const hiddenByMarkup = (e: Element) => e.hasAttribute('hidden') || e.hasAttribute('inert') || e.getAttribute('aria-hidden') === 'true' || (e as HTMLElement).style?.display === 'none';

/**
 * Nearest preceding heading within the surface (bounded walk); item titles are not section names.
 * A heading starts its own section, and headings of hidden siblings (other tab panels) do not count.
 */
function headingSection(el: Element, surface: SurfaceInfo): string | undefined {
  if (el.matches(HEADING) && !itemTitle(el)) {
    const own = clean(originalText(el));
    if (own) return own;
  }
  let steps = 0;
  for (let a: Element | null = el; a && a !== surface.el && steps < 60; a = a.parentElement) {
    for (let s = a.previousElementSibling; s && steps < 60; s = s.previousElementSibling, steps++) {
      if (hiddenByMarkup(s)) continue;
      const h = s.matches(HEADING) ? s : shownHeadingIn(s);
      if (h && !itemTitle(h)) return clean(originalText(h));
    }
  }
  return undefined;
}

/** First heading inside a preceding sibling that is not in a hidden part of it (a closed panel or menu). */
function shownHeadingIn(box: Element): Element | undefined {
  const inHidden = (h: Element) => {
    for (let e: Element | null = h; e && e !== box; e = e.parentElement) if (hiddenByMarkup(e)) return true;
    return false;
  };
  const first = box.querySelector(HEADING_IN);
  if (!first || !inHidden(first)) return first ?? undefined;
  for (const h of box.querySelectorAll(HEADING_IN)) if (!inHidden(h)) return h;
  return undefined;
}

/** A heading that titles one item: inside a list item / row / article, or next to a per-item menu button. */
function itemTitle(h: Element): boolean {
  if (h.closest('li,[role="listitem"],[role="row"],article,[role="article"]')) return true;
  const box = h.parentElement;
  return !!box?.querySelector(':scope > button[aria-haspopup="menu"], :scope > [role="button"][aria-haspopup="menu"]');
}

/**
 * The label written for a control: label[for], or the text block just before it in its row (the
 * common settings row "Display density / How much space items take up. | [control]"). Returns
 * the label element and, when the block has a second line, the description element.
 */
export function rowLabelOf(control: Element): { label: string; labelEl: Element; desc?: Element } | undefined {
  // A per-item "More options" menu has no question, and an item's own text is the user's, not a label.
  if (isItemMenu(control) || control.closest('li,[role="listitem"],[role="row"],article,[role="article"]')) return undefined;
  if (control.id) {
    const l = control.ownerDocument.querySelector(`label[for="${CSS.escape(control.id)}"]`);
    const t = l ? clean(originalText(l)) : undefined;
    if (l && t) return { label: t, labelEl: l };
  }
  for (let x: Element = control, d = 0; x.parentElement && d < 3; x = x.parentElement, d++) {
    if (x.parentElement.matches(ROW_STOP)) break;
    for (let y = x.previousElementSibling, k = 0; y && k < 2; y = y.previousElementSibling, k++) {
      if (y.matches(ANY_CONTROL) || y.querySelector(ANY_CONTROL)) break;
      const blocks = [...y.children].filter((c) => originalText(c).trim());
      const labelEl = blocks.length > 1 ? blocks[0]! : y;
      const t = clean(originalText(labelEl));
      if (!t || t.length > 80) continue;
      return { label: t, labelEl, ...(blocks.length > 1 ? { desc: blocks[1]! } : {}) };
    }
  }
  return undefined;
}

const MENU_WORDS_RE = /\b(more|options|actions|menu)\b|…|⋯|\.\.\./i;

/** An icon-only or "More options" menu button: it acts on an item, it answers no question. */
function isItemMenu(el: Element): boolean {
  if (!el.matches('[aria-haspopup="menu"],[aria-haspopup="true"]')) return false;
  const label = (originalAttr(el, 'aria-label') ?? originalText(el)).replace(/\s+/g, ' ').trim();
  return !label || MENU_WORDS_RE.test(label);
}

/** The control a text block labels or describes (the left column of a settings row). */
export function rowControlFor(el: Element): Element | undefined {
  for (let y: Element | null = el, d = 0; y && d < 3; y = y.parentElement, d++) {
    if (y.matches(ANY_CONTROL) || y.matches(ROW_STOP)) return undefined;
    const next = y.nextElementSibling;
    if (!next) continue;
    const roots = next.matches(CONTROL_ROOT) ? [next] : [...next.querySelectorAll(CONTROL_ROOT)];
    if (roots.length !== 1) continue;
    const rl = rowLabelOf(roots[0]!);
    if (rl && (rl.labelEl === el || rl.labelEl.contains(el) || rl.desc?.contains(el) || rl.labelEl.parentElement === y || y.contains(rl.labelEl))) return roots[0];
  }
  return undefined;
}

const roleForControl = (c: Element): GroupRole => {
  if (c.matches('[role="radiogroup"]')) return 'radiogroup';
  if (c.matches('select,[role="combobox"],[aria-haspopup]')) return 'select';
  return 'field';
};

/** Label of a native <select>: ARIA, label[for], a wrapping label, or its row. */
function selectLabel(sel: Element): string | undefined {
  return clean(originalAttr(sel, 'aria-label')) ?? referenced(sel, 'aria-labelledby') ?? clean(originalText(sel.closest('label') ?? sel.ownerDocument.createElement('i'))) ?? rowLabelOf(sel)?.label;
}

/** Label of a navigation collection for one of its items: the nearest sub-heading inside it, else its own name. */
function navLabel(container: Element, item: Element): string | undefined {
  const region = container.closest('nav,aside,[role="navigation"],[role="complementary"]') ?? container;
  let heading: Element | undefined;
  for (const h of region.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')) {
    if (h !== item && !h.contains(item) && h.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING) heading = h;
  }
  const own = (e: Element) => clean(originalAttr(e, 'aria-label')) ?? referenced(e, 'aria-labelledby');
  // A sub-heading inside the container names the items below it; else the container or its region.
  if (heading && container.contains(heading)) return clean(originalText(heading));
  return own(container) ?? (heading ? clean(originalText(heading)) : undefined) ?? own(region);
}

/** The control whose aria-describedby points at `el` (or a close ancestor of it). */
function describedControl(el: Element): Element | undefined {
  const root = rootOf(el) as ParentNode;
  for (let a: Element | null = el, d = 0; a && d < 3; a = a.parentElement, d++) {
    if (!a.id) continue;
    const c = root.querySelector(`[aria-describedby~="${CSS.escape(a.id)}"]`);
    if (c && !c.contains(el)) return c;
  }
  return undefined;
}

function groupRoleOf(g: Element): GroupRole {
  const role = g.getAttribute('role');
  if (role === 'radiogroup') return 'radiogroup';
  if (role === 'listbox') return 'listbox';
  if (role === 'menu' || role === 'menubar') return 'menu';
  if (role === 'tablist') return 'tablist';
  if (role === 'toolbar') return 'toolbar';
  if (g.querySelector('[role="combobox"],select')) return 'select';
  if (g.querySelector('[role="radiogroup"],[role="radio"]')) return 'radiogroup';
  if (g.querySelector('[role="switch"],[role="checkbox"],input[type="checkbox"]')) return 'field';
  return 'group';
}

/**
 * Group of `el`: the nearest group container that has a label (climbing past
 * unlabeled inner groups), so the outer question wins over a control that labels
 * itself with its own value. Popup items take the group of their trigger.
 */
export function groupOf(el: Element, surface: SurfaceInfo): Where['group'] {
  let unlabeled: Element | undefined;
  for (let g = el.closest(GROUP_SELECTOR), hops = 0; g && hops < 4; g = g.parentElement?.closest(GROUP_SELECTOR) ?? null, hops++) {
    if (surface.el && !surface.el.contains(g) && g !== surface.el) break;
    const label = groupLabel(g);
    // A popup labelled by its trigger is labelled by the current value: use the trigger's question instead.
    const byTrigger = g === surface.el && surface.kind !== 'dialog' && label !== undefined && label === controlLabel(triggerOf(g) ?? g);
    if (label && !byTrigger) return { role: groupRoleOf(g), label };
    unlabeled ??= g;
  }
  // A description belongs with the control it describes.
  const described = describedControl(el);
  if (described) return groupOf(described, surfaceOf(described));
  // A standalone checkbox or switch with its own <label>: one setting, label and description together.
  const lab = el.closest('label');
  const box = lab?.querySelector('input[type="checkbox"],[role="checkbox"],[role="switch"]');
  if (lab && box && !box.closest('[role="radiogroup"],fieldset,[role="group"]')) {
    const t = clean(originalText(lab));
    if (t) return { role: 'field', label: t };
  }
  if (el.matches('input[type="checkbox"],[role="checkbox"],[role="switch"]') && el.closest('label')) {
    const t = clean(originalText(el.closest('label')!));
    if (t) return { role: 'field', label: t };
  }
  // Options of a native <select> answer its label.
  const sel = el.closest('select');
  if (sel) {
    const l = selectLabel(sel);
    return { role: 'select', ...(l ? { label: l } : {}) };
  }
  // Items in a popup answer the question of the control that opened it.
  if (surface.el && surface.kind !== 'dialog') {
    const trigger = triggerOf(surface.el);
    if (trigger) {
      const tg = groupOf(trigger, surfaceOf(trigger));
      if (tg?.label) return tg;
      const tl = controlLabel(trigger);
      if (tl) return { role: surface.kind === 'listbox' ? 'select' : 'menu', label: tl };
    }
  }
  // A control whose question is written beside it, or that question's own title / description.
  const root = el.closest(CONTROL_ROOT);
  const rowControl = root && !root.matches('input[type="radio"],input[type="checkbox"]') ? root : rowControlFor(el);
  if (rowControl) {
    const rl = rowLabelOf(rowControl);
    if (rl) return { role: roleForControl(rowControl), label: rl.label };
  }
  // Items of a navigation collection: section or page names, grouped under their sub-heading.
  const nav = navCollectionOf(el);
  if (nav) {
    const l = navLabel(nav.container, el);
    return { role: nav.container.matches('[role="tablist"]') ? 'tablist' : 'nav', ...(l ? { label: l } : {}) };
  }
  return unlabeled ? { role: groupRoleOf(unlabeled) } : undefined;
}

export function itemRoleOf(el: Element, kind: EntryKind): ItemRole {
  if (kind === 'placeholder') return 'placeholder';
  if (kind === 'title') return 'tooltip';
  if (kind === 'aria-label') return 'aria-label';
  if (kind === 'aria-description') return 'description';
  if (kind === 'alt') return 'image';
  if (kind === 'value') return 'button';
  const target = el.closest('[role],button,a,label,legend,h1,h2,h3,h4,h5,h6') ?? el;
  // <label><radio/> Medium</label> (Base UI, native inputs): the text names that control.
  if (target.tagName === 'LABEL') {
    const c = target.querySelector('[role="radio"],[role="checkbox"],[role="switch"],input[type="radio"],input[type="checkbox"]');
    if (c) {
      const r = c.getAttribute('role') ?? (c as HTMLInputElement).type;
      return r === 'radio' ? 'radio' : r === 'switch' ? 'switch' : 'checkbox';
    }
  }
  const role = target.getAttribute('role');
  switch (role) {
    case 'tab': return 'tab';
    case 'menuitem': case 'menuitemradio': case 'menuitemcheckbox': return 'menuitem';
    case 'option': return 'option';
    case 'radio': return 'radio';
    case 'switch': return 'switch';
    case 'checkbox': return 'checkbox';
    case 'heading': return 'heading';
    case 'combobox': return 'value';
    case 'button': return 'button';
    case 'link': return 'link';
  }
  const tag = target.tagName;
  if (el.closest('option')) return 'option';
  if (el.closest('th,[role="columnheader"],[role="rowheader"]')) return 'heading';
  if (tag === 'BUTTON') return 'button';
  if (tag === 'A') return 'link';
  if (tag === 'LABEL') return 'label';
  if (tag === 'LEGEND') return 'legend';
  if (/^H[1-6]$/.test(tag)) return 'heading';
  return 'text';
}

/** Full structural description of a string at `el`. */
export function describe(el: Element, kind: EntryKind = 'text'): Where {
  const surface = surfaceOf(el);
  const where: Where = { surface: { kind: surface.kind, ...(surface.label ? { label: surface.label } : {}) }, role: itemRoleOf(el, kind) };
  // Popup items live where their trigger lives (a listbox opened from a settings field belongs to that section).
  const trigger = surface.el && surface.kind !== 'dialog' ? triggerOf(surface.el) : null;
  const section = trigger ? sectionOf(trigger, surfaceOf(trigger)) : sectionOf(el, surface);
  if (section) where.section = section;
  const group = groupOf(el, surface);
  if (group) where.group = group;
  // Navigation items name sections; they do not belong to one.
  if (group?.role === 'nav') delete where.section;
  // A string that IS the group label describes the group; it is not one of its options.
  if (where.group?.label && where.group.role !== 'nav' && kind === 'text' && clean(originalText(el)) === where.group.label) where.role = 'label';
  else if (where.role === 'text' && kind === 'text' && (isDescription(el) || rowControlFor(el))) where.role = 'description';
  return where;
}

/** Text referenced by some control's aria-describedby (a setting's explanation). */
function isDescription(el: Element): boolean {
  const root = rootOf(el) as ParentNode;
  for (let a: Element | null = el, d = 0; a && d < 3; a = a.parentElement, d++) {
    if (a.id && root.querySelector(`[aria-describedby~="${CSS.escape(a.id)}"]`)) return true;
  }
  return false;
}

/**
 * The subtree whose changes can change the context of strings at `el`: its
 * popup or dialog surface (section switches happen inside it), else the nearest
 * landmark. Used by the applier to re-check context-dependent translations.
 */
export function contextScope(el: Element): Element {
  return el.closest(SURFACE_SELECTOR) ?? el.closest('main,[role="main"],aside,nav,header,footer,form,section') ?? el.ownerDocument.body ?? el;
}

/**
 * Everything a string's context is read from: its scope, plus what lies outside it — the labels its
 * group points to with aria-labelledby, and the trigger (and that trigger's group) of a popup.
 */
export function contextAnchors(el: Element): Element[] {
  const out = new Set<Element>([contextScope(el)]);
  const root = rootOf(el) as Document;
  const addLabels = (g: Element | null) => {
    for (const id of (originalAttr(g ?? el, 'aria-labelledby') ?? '').split(/\s+/).filter(Boolean)) {
      const t = root.getElementById?.(id) ?? el.ownerDocument.getElementById(id);
      if (t) out.add(t);
    }
  };
  const group = el.closest(GROUP_SELECTOR);
  if (group) addLabels(group);
  const s = el.closest(SURFACE_SELECTOR);
  const trigger = s && surfaceKind(s) !== 'dialog' ? triggerOf(s) : null;
  if (trigger) {
    out.add(trigger);
    const tg = trigger.closest(GROUP_SELECTOR);
    if (tg) {
      out.add(tg);
      addLabels(tg);
    }
  }
  return [...out];
}

// ---------- context signature ----------

/** Canonical form for hashing: NFC, collapsed whitespace, lower case, 80 chars. */
export function canon(s: string | undefined): string {
  return (s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, MAX_LABEL);
}

/** FNV-1a 32-bit, base36, at least 4 characters. */
export function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(4, '0');
}

/**
 * Signatures for a place, most specific first. `g:` = section + group role +
 * group label (same-named groups in different sections differ; sibling options
 * are not part of it because they mount lazily). `s:` = surface + section + role,
 * for repeated buttons and headings outside groups.
 */
export function signatures(w: Where): string[] {
  const out: string[] = [];
  if (w.group?.label) out.push('g:' + fnv(`${canon(w.section)}|${w.group.role}|${canon(w.group.label)}`));
  out.push('s:' + fnv(`${w.surface.kind}|${canon(w.surface.label)}|${canon(w.section)}|${w.role}`));
  return out;
}

export const primarySignature = (w: Where): string => signatures(w)[0]!;

/** Human-readable context for review screens and prompts ("Settings › General › Transcript width"). */
export function whereText(w: Where): string {
  return [w.surface.label, w.section, w.group?.label].filter(Boolean).join(' › ');
}
