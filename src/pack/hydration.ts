// When it is safe to start rewriting a page. Server-rendered React/Vue/Angular
// apps compare server markup with their first client render ("hydration");
// text changed before that finishes causes mismatch errors and a client
// re-render that can lose state. Hydration cannot be observed reliably from an
// isolated world, so the default fails closed: wait for `load`, then for the
// DOM to go quiet. `immediate` is an opt-in per pack after testing a site.
import type { HydrationMode } from './format';

const QUIET_MS = 500;
const MAX_WAIT_MS = 5000;

/** Server-rendering markers visible in the DOM (page globals are not). */
export function looksServerRendered(doc: Document): boolean {
  return !!doc.querySelector(
    'script#__NEXT_DATA__, #__next, [data-reactroot], #__nuxt, #__nuxt-app, [ng-version], [ngh], [data-svelte-h], astro-island, [data-server-rendered]',
  ) || [...doc.scripts].some((s) => !s.src && s.textContent?.includes('self.__next_f'));
}

function waitFor(target: EventTarget, type: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    target.addEventListener(type, () => resolve(), { once: true, signal });
    signal?.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** Resolves once the document element exists (it may not at document_start). */
export async function whenDocumentElement(doc: Document): Promise<Element> {
  if (doc.documentElement) return doc.documentElement;
  await new Promise<void>((resolve) => {
    const mo = new MutationObserver(() => {
      if (doc.documentElement) {
        mo.disconnect();
        resolve();
      }
    });
    mo.observe(doc, { childList: true });
  });
  return doc.documentElement!;
}

/** Resolves when no DOM mutation happened for `quietMs`, or after `maxMs`. */
export function whenQuiet(doc: Document, quietMs = QUIET_MS, maxMs = MAX_WAIT_MS): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const done = () => {
      clearTimeout(timer);
      clearTimeout(cap);
      mo.disconnect();
      resolve();
    };
    const mo = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(done, quietMs);
    });
    mo.observe(doc.documentElement ?? doc, { childList: true, subtree: true, characterData: true });
    timer = setTimeout(done, quietMs);
    const cap = setTimeout(done, maxMs);
  });
}

export async function whenSafeToApply(doc: Document, mode: HydrationMode, signal?: AbortSignal): Promise<void> {
  await whenDocumentElement(doc);
  if (mode === 'immediate' || signal?.aborted) return;
  if (doc.readyState !== 'complete' && doc.defaultView) await waitFor(doc.defaultView, 'load', signal);
  if (signal?.aborted) return;
  await whenQuiet(doc);
}
