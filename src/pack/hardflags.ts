// Contact data and links in a string: never stored in a pack, a selector or any
// label, whatever path the string comes from (collection, generation, import).
// No dependencies, so the format validator can use it too.

export const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
export const URL_RE = /\b(?:https?:\/\/|www\.)\S+/i;
export const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/;
export const HANDLE_RE = /(^|\s)@[\w.-]{2,}/;

/** Email, URL, phone number or @handle anywhere in `s`. */
export function hasContactData(s: string): boolean {
  return EMAIL_RE.test(s) || URL_RE.test(s) || PHONE_RE.test(s) || HANDLE_RE.test(s);
}

/** A selector whose quoted attribute values carry contact data or a long number (an id of something personal). */
export function selectorLooksPersonal(sel: string): boolean {
  return [...sel.matchAll(/["']([^"']*)["']/g)].some((m) => hasContactData(m[1]!) || /\d{5,}/.test(m[1]!));
}

/** Scrub contact data from free-form metadata before saving or exporting it. */
export function redactContactData(s: string): string {
  return s.replace(new RegExp(EMAIL_RE.source, 'g'), '').replace(new RegExp(URL_RE.source, 'gi'), '')
    .replace(new RegExp(PHONE_RE.source, 'g'), '').replace(new RegExp(HANDLE_RE.source, 'g'), '')
    .replace(/\s{2,}/g, ' ').trim();
}
