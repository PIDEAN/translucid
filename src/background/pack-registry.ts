// Keeps the runtime-registered pack content script in step with the pack index,
// so the document_start script only runs on hosts that have an enabled pack.
import { browser } from 'wxt/browser';
import type { PackIndexItem } from '../pack/format';

export const PACK_SCRIPT_ID = 'translucid-pack';
/** WXT output path of entrypoints/pack.content.ts. */
export const PACK_SCRIPT_FILE = '/content-scripts/pack.js';

/** Match patterns for enabled packs (a host pattern without a port matches every port). */
export function matchesFor(index: PackIndexItem[]): string[] {
  const hosts = new Set(index.filter((p) => p.enabled).flatMap((p) => p.hosts));
  return [...hosts].sort().map((h) => `*://${h}/*`);
}

const same = (a: string[] = [], b: string[] = []) => a.length === b.length && [...a].sort().every((v, i) => v === b[i]);

/** Differential reconciliation: register, update or unregister only when the match list changed. */
export async function syncRegistrations(index: PackIndexItem[]): Promise<void> {
  const want = matchesFor(index);
  const [current] = await browser.scripting.getRegisteredContentScripts({ ids: [PACK_SCRIPT_ID] });
  if (!want.length) {
    if (current) await browser.scripting.unregisterContentScripts({ ids: [PACK_SCRIPT_ID] });
    return;
  }
  if (current && same(current.matches, want)) return;
  if (current) {
    await browser.scripting.updateContentScripts([{ id: PACK_SCRIPT_ID, js: [PACK_SCRIPT_FILE], matches: want }]);
  } else {
    await browser.scripting.registerContentScripts([
      { id: PACK_SCRIPT_ID, js: [PACK_SCRIPT_FILE], matches: want, runAt: 'document_start', allFrames: false, persistAcrossSessions: true },
    ]);
  }
}

/** Start the pack script in tabs that are already open (it guards against running twice). */
export async function injectIntoOpenTabs(hosts: string[]): Promise<void> {
  if (!hosts.length) return;
  const tabs = await browser.tabs.query({ url: hosts.map((h) => `*://${h}/*`) });
  await Promise.all(
    tabs.map((t) =>
      t.id === undefined
        ? undefined
        : browser.scripting.executeScript({ target: { tabId: t.id }, files: [PACK_SCRIPT_FILE] }).catch(() => undefined),
    ),
  );
}
