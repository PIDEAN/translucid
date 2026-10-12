// DOM rules shared by the pack applier and harvester.
import { OUR_TAGS } from '../shared/dom-tags';

/** Never touched: code, editors, form values, scripts, our own nodes. (Native <select> option labels are interface.) */
export const SKIP_SELECTOR = [
  'script', 'style', 'noscript', 'template', 'code', 'pre', 'kbd', 'samp', 'textarea', 'svg', 'canvas', 'iframe',
  '[contenteditable]:not([contenteditable="false"])', '[translate="no"]', '.notranslate',
].join(',');

/** Containers that usually hold user content (chat transcripts, rendered documents). */
export const USER_CONTENT_SELECTOR = [
  '[role="log"]', '[role="article"]', 'article', '.prose', '.markdown', '[class*="markdown"]', '[data-message-author-role]',
  '[data-testid*="message"]', '[class*="message-content"]',
].join(',');

/** Controls whose labels stay UI even inside user-content containers ("Copy" under a chat message). */
export const CONTROL_SELECTOR = 'button,[role="button"],[role="menuitem"],[role="tab"],[role="option"],label,summary';

const ICON_CLASS_RE = /(^|[\s_-])(material-(icons|symbols)[\w-]*|fa-|fas|far|fab|codicon|icon-font|glyphicon)/i;
const ICON_FONT_RE = /material (icons|symbols)|font ?awesome|codicon|icomoon|glyphicons/i;

/** Icon-font ligatures ("settings" rendered as a gear) must never be translated. */
export function isIconFont(el: Element): boolean {
  const cls = typeof el.className === 'string' ? el.className : el.getAttribute('class') ?? '';
  if (ICON_CLASS_RE.test(cls)) return true;
  const view = el.ownerDocument?.defaultView;
  if (!view) return false;
  try {
    return ICON_FONT_RE.test(view.getComputedStyle(el).fontFamily);
  } catch {
    return false;
  }
}

export function joinSelectors(list: string[]): string {
  return list
    .filter((s) => {
      try {
        document.createDocumentFragment().querySelector(s);
        return true;
      } catch {
        return false;
      }
    })
    .join(',');
}

export interface ElementRules {
  /** Pack-specific excludes (user content the user marked), joined into one selector. */
  exclude: string;
}

/** Cheap per-element test used while walking: prune this element and its subtree? */
export function skipSubtree(el: Element, rules: ElementRules): boolean {
  if (OUR_TAGS.has(el.tagName)) return true;
  if (el.matches(SKIP_SELECTOR)) return true;
  return !!rules.exclude && el.matches(rules.exclude);
}

/** Same test including ancestors, for the root of a walk that starts mid-tree. */
export function skipFromAncestors(el: Element, rules: ElementRules): boolean {
  for (let a: Element | null = el; a; a = a.parentElement) {
    if (OUR_TAGS.has(a.tagName)) return true;
  }
  if (el.closest(SKIP_SELECTOR)) return true;
  return !!rules.exclude && !!el.closest(rules.exclude);
}

/**
 * Final check before writing (only after a translation was found, so the costly
 * parts run rarely): user-content containers, except labels of controls inside
 * them, and icon-font ligatures.
 */
export function blockedForApply(el: Element): boolean {
  const user = el.closest(USER_CONTENT_SELECTOR);
  if (user) {
    const control = el.closest(CONTROL_SELECTOR);
    if (!control || !user.contains(control)) return true;
  }
  return isIconFont(el);
}
