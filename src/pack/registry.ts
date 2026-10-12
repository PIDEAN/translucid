// Ownership registry shared by the pack applier and the article translator.
// Both content scripts of this extension run in the same isolated world, so a
// global keyed by a registered symbol is visible to each bundle without putting
// marker attributes on the page's DOM.

export interface PackRegistry {
  /** Text nodes whose value the applier replaced. */
  ownedText: WeakSet<Node>;
  /** Elements with at least one attribute the applier replaced. */
  ownedAttr: WeakSet<Element>;
  /** Source-language originals of replaced text, so structure analysis reads the page as the app wrote it. */
  origText: WeakMap<Node, string>;
  origAttr: WeakMap<Element, Map<string, string>>;
  /** True while an exploration scan runs (continued learning pauses). */
  scanning: boolean;
  listeners: Set<() => void>;
}

const KEY = Symbol.for('translucid.pack.registry');

export function packRegistry(): PackRegistry {
  const g = globalThis as unknown as Record<symbol, Partial<PackRegistry> | undefined>;
  const r = (g[KEY] ??= {});
  r.ownedText ??= new WeakSet();
  r.ownedAttr ??= new WeakSet();
  r.origText ??= new WeakMap();
  r.origAttr ??= new WeakMap();
  r.scanning ??= false;
  r.listeners ??= new Set();
  return r as PackRegistry;
}

/** Original (source-language) value of a text node. */
export function originalData(t: Node): string {
  return packRegistry().origText.get(t) ?? t.nodeValue ?? '';
}

/** Original value of an attribute, or null if absent. */
export function originalAttr(el: Element, name: string): string | null {
  return packRegistry().origAttr.get(el)?.get(name) ?? el.getAttribute(name);
}

/** Original text content of an element (concatenated original text nodes). */
export function originalText(el: Node): string {
  if (el.nodeType === Node.TEXT_NODE) return originalData(el);
  let out = '';
  const doc = el.ownerDocument;
  if (!doc) return el.textContent ?? '';
  const w = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) out += originalData(n);
  return out;
}

/** True if `n` is, or contains, something the pack applier owns. */
export function containsOwned(n: Node): boolean {
  const r = packRegistry();
  if (n.nodeType === Node.TEXT_NODE) return r.ownedText.has(n);
  if (n.nodeType !== Node.ELEMENT_NODE) return false;
  if (r.ownedAttr.has(n as Element)) return true;
  const doc = n.ownerDocument;
  if (!doc) return false;
  const walker = doc.createTreeWalker(n, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let c = walker.nextNode(); c; c = walker.nextNode()) {
    if (c.nodeType === Node.TEXT_NODE ? r.ownedText.has(c) : r.ownedAttr.has(c as Element)) return true;
  }
  return false;
}

export function onOwnershipChange(fn: () => void): () => void {
  const r = packRegistry();
  r.listeners.add(fn);
  return () => r.listeners.delete(fn);
}

export function notifyOwnership(): void {
  for (const fn of packRegistry().listeners) {
    try {
      fn();
    } catch (e) {
      console.debug('[translucid] ownership listener failed', e);
    }
  }
}
