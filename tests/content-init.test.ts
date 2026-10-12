// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

// The real page translation entry, with storage that fails to load: nothing that waits on it may hang.
const env = vi.hoisted(() => ({
  listeners: [] as ((raw: unknown, sender: unknown, reply: (r: unknown) => void) => boolean | undefined)[],
  rejectSettings: (_e: Error) => {},
}));
vi.mock('wxt/browser', () => ({ browser: {
  runtime: {
    onMessage: { addListener: (fn: (typeof env.listeners)[number]) => env.listeners.push(fn) },
    sendMessage: async () => null,
    connect: () => ({ postMessage: () => {}, onMessage: { addListener: () => {} }, onDisconnect: { addListener: () => {} } }),
    lastError: undefined,
  },
} }));
vi.mock('../src/shared/settings', () => ({
  loadSettings: () => new Promise((_resolve, reject) => { env.rejectSettings = reject; }),
  onSettingsChanged: () => {},
}));

describe('page translation entry', () => {
  it('answers requests that waited for set-up when it fails, and does not hold later ones', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { default: script } = await import('../entrypoints/content');
    const running = (script as unknown as { main: () => Promise<void> }).main();
    await Promise.resolve();
    const listen = env.listeners[0]!;
    const replies: unknown[] = [];
    // Arrives while settings load: held for an answer.
    expect(listen({ type: 'get-state' }, {}, (r) => replies.push(r))).toBe(true);
    env.rejectSettings(new Error('storage unavailable'));
    await running;
    expect(replies).toEqual([null]);
    // After the failure: not held (the caller gets no answer at once instead of waiting forever).
    const later: unknown[] = [];
    expect(listen({ type: 'set-enabled', enabled: true }, {}, (r) => later.push(r))).toBe(false);
    expect(later).toEqual([]);
  });
});
