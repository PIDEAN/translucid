// @vitest-environment happy-dom
// @vitest-environment-options {"url": "https://docs.example.com/page"}
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageIntent } from '../src/shared/messages';

// The real page translation entry, running in a page-sized frame of a site set to "always translate".
// Answers to frame-join are held so the test decides when (and in which order) they arrive.
const env = vi.hoisted(() => ({ joins: [] as ((v: unknown) => void)[] }));
vi.mock('wxt/browser', () => ({ browser: {
  runtime: {
    onMessage: { addListener: () => {} },
    sendMessage: (msg: { type: string }) => (msg.type === 'frame-join' ? new Promise((r) => env.joins.push(r)) : Promise.resolve(null)),
    connect: () => ({ postMessage: () => {}, onMessage: { addListener: () => {} }, onDisconnect: { addListener: () => {} } }),
    lastError: undefined,
  },
} }));
vi.mock('../src/shared/settings', async () => {
  const actual = await vi.importActual<typeof import('../src/shared/settings')>('../src/shared/settings');
  return { ...actual, loadSettings: async () => ({ ...actual.DEFAULT_SETTINGS, siteRules: [{ host: 'docs.example.com', mode: 'always' }] }), onSettingsChanged: () => {} };
});

const intent = (version: number, enabled: boolean | null): PageIntent => ({ doc: 'page-a', version, enabled, mode: null, expertId: null });
const g = globalThis as unknown as Record<string, (...a: unknown[]) => unknown>;
const report = () => g.__translucidFrameState!() as { state: { enabled: boolean }; follows: { doc: string | null; version: number } };

/** Starts the entry in the frame and returns once it asked its page (wrapped: an async function returning
 * the main() promise would wait for it). */
async function runFrame(): Promise<{ running: Promise<void> }> {
  vi.resetModules();
  env.joins = [];
  Object.defineProperty(window, 'top', { configurable: true, get: () => ({}) });
  (window as unknown as Record<string, unknown>).IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  document.body.innerHTML = '<p>A paragraph of the framed article, long enough to translate.</p>';
  const { default: script } = await import('../entrypoints/content');
  const running = (script as unknown as { main: () => Promise<void> }).main();
  for (let i = 0; i < 100 && !env.joins.length; i++) await new Promise((r) => setTimeout(r, 10));
  expect(env.joins).toHaveLength(1);
  return { running };
}

describe('a frame joining a page set to always translate', () => {
  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));

  it('an older answer arriving after a newer 显示原文 does not turn the frame back on', async () => {
    const { running } = await runFrame();
    // 显示原文 (version 1) is written in while the frame's first question is still unanswered.
    g.__translucidApplyIntent!(intent(1, false));
    // Answers arrive newest first, the older one last.
    if (env.joins.length > 1) env.joins[1]!(intent(1, false));
    env.joins[0]!(intent(0, null));
    await running;
    await new Promise((r) => setTimeout(r, 0));
    expect(report().state.enabled).toBe(false);
    expect(report().follows).toEqual({ doc: 'page-a', version: 1 });
  });

  it('with no choice on the page yet, the site rule turns the frame on', async () => {
    const { running } = await runFrame();
    env.joins[0]!(intent(0, null));
    await running;
    expect(report().state.enabled).toBe(true);
  });

  it('with no answer from the page at all, the site rule alone decides', async () => {
    const { running } = await runFrame();
    env.joins[0]!(null);
    await running;
    expect(report().state.enabled).toBe(true);
    expect(report().follows.doc).toBeNull();
  });
});
