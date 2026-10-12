import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageIntent, TabState } from '../src/shared/messages';

// A tab with a top document and two page frames. executeScript runs the function passed for each
// document against what that document exposes, as the content scripts' isolated world would.
const tab = vi.hoisted(() => ({ sent: [] as { cmd: unknown; options: unknown }[], frames: {} as Record<number, Record<string, unknown>> }));
const state = (enabled: boolean) => ({ enabled, mode: 'bilingual', expertOverride: '', resolvedExpert: null, stats: { segments: 3, done: enabled ? 3 : 0, errors: 0, pending: 0 }, firstPaintMs: null, avgTtftMs: null, lang: 'en', estimate: enabled ? null : 3, pageInfo: null, selectionInSegment: false }) as TabState;
const intent = (version: number, enabled: boolean | null): PageIntent => ({ doc: 'page-a', version, enabled, mode: null, expertId: null });
vi.mock('wxt/browser', () => ({ browser: {
  scripting: { executeScript: async ({ target, func, args }: { target: { frameIds?: number[] }; func: (...a: unknown[]) => unknown; args: unknown[] }) =>
    Object.entries(tab.frames)
      .filter(([id]) => !target.frameIds || target.frameIds.includes(Number(id)))
      .map(([id, world]) => {
        // Run the injected function with this document's isolated world in place of the global one.
        const g = globalThis as unknown as Record<string, unknown>;
        Object.assign(g, world);
        try {
          return { frameId: Number(id), result: func(...args) };
        } finally {
          for (const k of ['__translucidFrameState', '__translucidApplyIntent']) delete g[k];
        }
      }),
  },
  tabs: { sendMessage: async (_id: number, cmd: unknown, options: unknown) => {
    tab.sent.push({ cmd, options });
    return { ...state(false), intent: intent(top.version, top.enabled) };
  } },
} }));

// The top document's current intent (what it answers commands with and reports in reads).
const top = { version: 6, enabled: true as boolean | null };

// Each document's isolated world: the getter, and in frames the intent setter.
function world(id: number, report: () => unknown, set?: (i: unknown) => void) {
  tab.frames[id] = { __translucidFrameState: report, ...(set ? { __translucidApplyIntent: set } : {}) };
}

describe('sending page translation commands to a tab', () => {
  let received: Record<number, unknown[]>;
  beforeEach(() => {
    top.version = 6;
    top.enabled = true;
    tab.sent = [];
    tab.frames = {};
    received = { 4: [], 5: [] };
    // Frames report the version they follow, and take a newer one when it is written to them.
    const followed: Record<number, number> = { 4: 6, 5: 3 };
    const take = (id: number) => (i: unknown) => {
      received[id]!.push(i);
      followed[id] = Math.max(followed[id]!, (i as PageIntent).version);
    };
    world(0, () => ({ state: state(true), intent: intent(top.version, top.enabled) }));
    world(4, () => ({ state: state(true), follows: { doc: 'page-a', version: followed[4] } }), take(4));
    world(5, () => ({ state: state(true), follows: { doc: 'page-a', version: followed[5] } }), take(5));
  });

  it('page-wide commands go to the top document, and its new intent is written into every frame', async () => {
    const { sendToTab } = await import('../src/shared/tab-state');
    top.version = 7;
    top.enabled = false;
    await sendToTab(1, { type: 'toggle' });
    expect(tab.sent).toEqual([{ cmd: { type: 'toggle' }, options: { frameId: 0 } }]);
    // Written once each; the read back finds every frame in step and writes nothing more.
    expect(received[4]).toEqual([intent(7, false)]);
    expect(received[5]).toEqual([intent(7, false)]);
  });

  it('per-document commands go to every document', async () => {
    const { sendToTab } = await import('../src/shared/tab-state');
    await sendToTab(1, { type: 'retry-failed' });
    expect(tab.sent).toEqual([{ cmd: { type: 'retry-failed' }, options: undefined }]);
    expect(received[4]).toEqual([]);
  });

  it('reading the tab puts a frame that missed an update back in step', async () => {
    const { tabState } = await import('../src/shared/tab-state');
    expect((await tabState(1))!.stats).toEqual({ segments: 9, done: 9, errors: 0, pending: 0 });
    expect(received[4]).toEqual([]);
    expect(received[5]).toEqual([intent(6, true)]);
  });
});
