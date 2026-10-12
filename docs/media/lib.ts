// Shared helpers for the README media captures: a fresh Chromium with the built extension, runtime messages,
// popup screenshots, and a recorder that writes each scene's frames plus a JSON timeline for the Remotion video.
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const HERE = fileURLToPath(new URL('.', import.meta.url));
export const OUT = join(HERE, '.out');
/** The page area inside the browser window drawn by the video (CSS px). */
export const VIEW = { width: 1160, height: 600 };
/** Provider address in the frames; launch() maps it onto the local media translator. */
const MEDIA_API_HOST = 'api.deepseek.com';

export interface Box { x: number; y: number; w: number; h: number }
export interface Shot {
  img: string;
  /** Popup screenshot shown over the page, under the toolbar icon. */
  popup?: string;
  /** How long the shot stays on screen (ms). */
  dur: number;
  /** Where the pointer goes during this shot (CSS px of the page or of the popup; 'toolbar' is the extension icon). */
  cursor?: { x: number; y: number; on: 'page' | 'popup' | 'toolbar' };
  /** Click at the end of this shot; the next shot shows the result. */
  click?: boolean;
  caption?: string;
  /** Page area the camera eases into (CSS px). */
  zoom?: Box;
  /** How this shot replaces the previous one. */
  enter?: 'cut' | 'fade' | 'sweep';
  /** Language chip highlighted under the window (the languages scene). */
  lang?: string;
  /** URL shown in the address bar. */
  url?: string;
  /** Keys pressed just before this shot (shown as keycaps). */
  keys?: string[];
  /** Playback speed of a sped-up stretch (shown as a badge). */
  speed?: number;
  /** Page boxes outlined once the camera settles (CSS px). */
  marks?: Box[];
}

export interface Ext { context: BrowserContext; extId: string; ext: Page; msg: <T = any>(m: unknown) => Promise<T> }

export async function launch(): Promise<Ext> {
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'translucid-media-')), {
    channel: 'chromium',
    deviceScaleFactor: 2,
    viewport: VIEW,
    args: [
      `--disable-extensions-except=${join(ROOT, 'dist/chrome-mv3')}`,
      `--load-extension=${join(ROOT, 'dist/chrome-mv3')}`,
      // The DeepSeek preset's address goes to the local media translator (mock-translate.mjs), never the internet.
      `--host-resolver-rules=MAP ${MEDIA_API_HOST} 127.0.0.1:5303`,
      '--ignore-certificate-errors',
    ],
  });
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extId}/options.html#/config`);
  const msg = <T,>(m: unknown) => ext.evaluate((x) => chrome.runtime.sendMessage(x), m) as Promise<T>;
  return { context, extId, ext, msg };
}

/** Point the main provider at the local media translator (hand-written Chinese, never a real model). */
export async function useMediaTranslator(ext: Page): Promise<void> {
  await ext.evaluate(async (host) => {
    const { settings } = await chrome.storage.local.get('settings');
    const s = settings ?? {};
    const providers = (s.providers ?? []).filter((p: { id: string }) => p.id !== 'demo');
    providers.push({ id: 'demo', name: 'DeepSeek', vendor: 'deepseek', baseURL: `https://${host}/v1`, apiKey: 'demo', model: 'deepseek-flash', extraBody: {}, includeUsage: true, concurrency: 2 });
    await chrome.storage.local.set({ settings: { ...s, providers, activeProviderId: 'demo', fallbackProviderId: '', preprocess: 'off', autoTranslate: false } });
  }, MEDIA_API_HOST);
}

export async function tabOf(ext: Page, url: string): Promise<{ id: number }> {
  return ext.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]!, `${url.split('#')[0]}*`);
}

/** Serve a docs/media page at a made-up address: requests never leave the browser, and the popup and the
 * workbench show a believable site name instead of localhost. */
export async function serve(page: Page, url: string, html: string): Promise<string> {
  await page.route(url, (r) => r.fulfill({ contentType: 'text/html', body: html }));
  return url;
}

export class Recorder {
  shots: Shot[] = [];
  private n = 0;
  constructor(readonly scene: string) {
    rmSync(join(OUT, scene), { recursive: true, force: true });
    mkdirSync(join(OUT, scene), { recursive: true });
  }
  private file(kind: string): string {
    return `${this.scene}/${String(this.n++).padStart(3, '0')}-${kind}.png`;
  }
  private last?: Buffer;
  /** Screenshot the page as one shot; a frame identical to the previous plain frame only extends it. */
  async page(p: Page, opts: Omit<Shot, 'img'>): Promise<Shot> {
    const buf = await p.screenshot();
    const prev = this.shots.at(-1);
    const plain = (s: Omit<Shot, 'img'>) => !s.cursor && !s.click && !s.zoom && !s.keys && !s.popup && !s.marks;
    if (prev && this.last?.equals(buf) && plain(prev) && plain(opts) && prev.caption === opts.caption && prev.url === opts.url) {
      prev.dur += opts.dur;
      return prev;
    }
    const img = this.file('page');
    writeFileSync(join(OUT, img), buf);
    this.last = buf;
    const shot = { img, ...opts };
    this.shots.push(shot);
    return shot;
  }
  /** Screenshot the popup (#app only); returns its file and the boxes of the given elements inside it. */
  async popup(p: Page, targets: Record<string, string> = {}): Promise<{ img: string; boxes: Record<string, Box> }> {
    const img = this.file('popup');
    await p.locator('#app').screenshot({ path: join(OUT, img) });
    const boxes: Record<string, Box> = {};
    for (const [k, sel] of Object.entries(targets)) {
      const b = (await p.locator(sel).first().boundingBox())!;
      boxes[k] = { x: b.x, y: b.y, w: b.width, h: b.height };
    }
    return { img, boxes };
  }
  save(extra: Record<string, unknown> = {}): void {
    writeFileSync(join(OUT, `${this.scene}.json`), JSON.stringify({ scene: this.scene, view: VIEW, ...extra, shots: this.shots }, null, 1));
  }
}

export const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

export async function boxOf(p: Page, selector: string): Promise<Box> {
  const b = (await p.locator(selector).first().boundingBox())!;
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}

/** A popup page for `tab`, as if opened from the toolbar while that tab is active. */
export async function openPopup(x: Ext, tab: { id: number }, which: 'site' | 'page'): Promise<Page> {
  const popup = await x.context.newPage();
  await popup.addInitScript(([t, w]) => {
    localStorage.setItem('translucid.popup.tab', w as string);
    const q = chrome.tabs.query.bind(chrome.tabs);
    // @ts-expect-error capture stub: the popup asks for the active tab
    chrome.tabs.query = (info: chrome.tabs.QueryInfo) => (info.active ? Promise.resolve([t]) : q(info));
  }, [tab, which] as const);
  await popup.setViewportSize({ width: 372, height: 640 });
  await popup.goto(`chrome-extension://${x.extId}/popup.html`);
  await popup.waitForTimeout(700);
  return popup;
}
