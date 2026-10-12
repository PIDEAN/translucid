import { chromium, test as base, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('../dist/chrome-mv3', import.meta.url));
export const FIXTURES = 'http://localhost:5300';

interface Fixtures {
  context: BrowserContext;
  sw: Worker;
  extId: string;
  /** An extension page (options) used to talk to the background like the real UI does. */
  ext: Page;
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'translucid-e2e-')), {
      channel: 'chromium',
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    await use(ctx);
    await ctx.close();
  },
  sw: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(sw);
  },
  extId: async ({ sw }, use) => {
    await use(new URL(sw.url()).host);
  },
  ext: async ({ context, extId }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/options.html#/config`);
    await use(page);
  },
});

export const expect = test.expect;

/** Send a runtime message from the extension page and return the reply. */
export function runtimeMessage<T = any>(ext: Page, msg: unknown): Promise<T> {
  return ext.evaluate((m) => chrome.runtime.sendMessage(m), msg) as Promise<T>;
}

/** Send a tab message (popup-style) to the tab showing `url`. */
export function tabMessage<T = any>(ext: Page, url: string, msg: unknown): Promise<T> {
  return ext.evaluate(
    async ([u, m]) => {
      const [tab] = await chrome.tabs.query({ url: u as string });
      return chrome.tabs.sendMessage(tab!.id!, m);
    },
    [url, msg] as const,
  ) as Promise<T>;
}

export function fixturePack(patch: Record<string, unknown> = {}) {
  return {
    format: 'translucid-site-pack',
    version: 1,
    site: { hosts: ['localhost'], scopes: ['/'], name: 'Fixture', description: 'Test pages' },
    regions: [],
    sourceLang: 'en',
    targetLang: 'zh-CN',
    glossary: [],
    entries: [
      { kind: 'text', src: 'New chat', t: '新建对话', status: 'auto' },
      { kind: 'text', src: 'Settings', t: '设置', status: 'auto' },
      { kind: 'text', src: 'Copy', t: '复制', status: 'auto' },
      { kind: 'text', src: 'Archive', t: '归档', status: 'auto' },
      { kind: 'text', src: 'Rename', t: '重命名', status: 'auto' },
      { kind: 'text', src: 'Delete', t: '删除', status: 'auto' },
      { kind: 'placeholder', src: 'Search chats', t: '搜索对话', status: 'auto' },
      { kind: 'aria-label', src: 'Open menu', t: '打开菜单', status: 'auto' },
      { kind: 'title', src: 'Share', t: '分享', status: 'auto' },
      { kind: 'value', src: 'Send', t: '发送', status: 'auto' },
    ],
    excludes: [],
    options: { hydration: 'after-idle' },
    generator: { model: 'fixture', promptVersion: 1, createdAt: 0, updatedAt: 0 },
    rev: 0,
    ...patch,
  };
}

/** Point the main provider at the local mock LLM (http://localhost:5301). */
export async function useMockProvider(ext: Page): Promise<void> {
  await ext.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    const s = settings ?? {};
    const providers = (s.providers ?? []).filter((p: { id: string }) => p.id !== 'mock');
    providers.push({
      id: 'mock', name: 'Mock LLM', vendor: 'custom', baseURL: 'http://localhost:5301/v1', apiKey: 'test-key', model: 'mock-1',
      extraBody: {}, includeUsage: true, concurrency: 2,
    });
    await chrome.storage.local.set({ settings: { ...s, providers, activeProviderId: 'mock', fallbackProviderId: '' } });
  });
}

export async function setMockDelay(ms: number): Promise<void> {
  await fetch(`http://localhost:5301/control?delay=${ms}`);
}
