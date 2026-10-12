// Reading and driving a tab's page translation as one page, across the documents it runs in (frame-state.ts).
import { browser } from 'wxt/browser';
import { combineStates, FRAME_INTENT_SETTER, FRAME_STATE_GETTER, PAGE_COMMANDS, staleFrames, type FrameReport } from './frame-state';
import type { PageIntent, TabCommand, TabState, TopReply } from './messages';

/** Write the top document's page intent into frames of the tab (all of them, or the given ones). */
async function deliverIntent(tabId: number, intent: PageIntent, frameIds?: number[]): Promise<void> {
  await browser.scripting
    .executeScript({
      target: frameIds ? { tabId, frameIds } : { tabId, allFrames: true },
      args: [FRAME_INTENT_SETTER, intent],
      // Runs in the content scripts' isolated world, where only frames expose the setter.
      func: (name: string, value: unknown) => {
        const set = (globalThis as unknown as Record<string, unknown>)[name];
        if (typeof set === 'function') (set as (v: unknown) => void)(value);
      },
    })
    .catch(() => {
      // A frame navigating away or gone: the next state read, or the frame itself on focus, catches up.
    });
}

/** The tab's combined state, or null when no document in it runs page translation. Frames found behind
 * the top document's intent get it again on the way. */
export async function tabState(tabId: number): Promise<TabState | null> {
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId, allFrames: true },
      args: [FRAME_STATE_GETTER],
      // Runs in the content scripts' isolated world, where the getter lives; pages cannot reach it.
      func: (name: string) => {
        const get = (globalThis as unknown as Record<string, unknown>)[name];
        return typeof get === 'function' ? (get as () => unknown)() : null;
      },
    });
    const reports = results.filter((r) => r.result).map((r) => ({ frameId: r.frameId, report: r.result as FrameReport }));
    const stale = staleFrames(reports);
    if (stale) await deliverIntent(tabId, stale.intent, stale.frameIds);
    if (reports.length) return combineStates(reports.map((r) => ({ frameId: r.frameId, state: r.report.state })));
  } catch {
    // No access to the tab (chrome:// pages, the Web Store): ask the top document directly below.
  }
  return ((await browser.tabs.sendMessage(tabId, { type: 'get-state' } satisfies TabCommand, { frameId: 0 }).catch(() => null)) as TabState | null) ?? null;
}

/**
 * Send a page translation command to the tab. Page-wide ones (on or off, display mode, expert) go to the
 * top document, which resolves toggles against its own state one after another; its reply carries the new
 * page intent, written into every frame (and checked once) before this returns. The rest act in every document.
 */
export async function sendToTab(tabId: number, cmd: TabCommand): Promise<void> {
  if (!PAGE_COMMANDS.has(cmd.type)) {
    await browser.tabs.sendMessage(tabId, cmd);
    return;
  }
  const reply = (await browser.tabs.sendMessage(tabId, cmd, { frameId: 0 })) as TopReply | undefined;
  if (!reply?.intent) return;
  await deliverIntent(tabId, reply.intent);
  // One read back: a frame that missed the write gets the intent again (keyboard commands have no popup polling).
  await tabState(tabId);
}
