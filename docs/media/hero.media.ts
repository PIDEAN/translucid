// Frames of the README hero animation: the real extension applies language packs to a made-up app
// (notara.html), one language at a time. compose_hero.py turns the frames into docs/images/hero.gif.
import { chromium, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('../../dist/chrome-mv3', import.meta.url));
const HERE = fileURLToPath(new URL('.', import.meta.url));
const FRAMES = join(HERE, '.out', 'frames');
const PAGE = 'http://localhost:5300/notara.html';
const html = readFileSync(join(HERE, 'notara.html'), 'utf8');
const tr = JSON.parse(readFileSync(join(HERE, 'notara-translations.json'), 'utf8')) as { keys: string[]; langs: Record<string, string[]> };
const ORDER = ['en', 'zh-CN', 'ja', 'es', 'de', 'fr', 'ko'];

/** A language pack for the demo app, in the import format (the translations are hand-written). */
function pack(lang: string) {
  const values = tr.langs[lang]!;
  return {
    format: 'translucid-site-pack',
    version: 1,
    site: { hosts: ['localhost'], scopes: ['/'], name: 'Notara', description: 'A notes app' },
    regions: [],
    sourceLang: 'en',
    targetLang: lang,
    glossary: [],
    entries: tr.keys.map((src, i) => ({ kind: src === 'Search notes' ? 'placeholder' : 'text', src, t: values[i]!, status: 'auto' })),
    excludes: [],
    options: { hydration: 'immediate' },
    generator: { model: 'hand-written', promptVersion: 1, createdAt: 0, updatedAt: 0 },
    rev: 0,
  };
}

test('hero frames', async () => {
  mkdirSync(FRAMES, { recursive: true });
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'translucid-hero-')), {
    channel: 'chromium',
    deviceScaleFactor: 2,
    viewport: { width: 960, height: 620 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extId}/options.html#/config`);
  const msg = (m: unknown) => ext.evaluate((x) => chrome.runtime.sendMessage(x), m) as Promise<any>;
  for (const lang of ORDER.slice(1)) {
    const r = await msg({ type: 'pack-save', pack: pack(lang), enabled: false });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  }

  const page = await context.newPage();
  await page.route(PAGE, (r) => r.fulfill({ contentType: 'text/html', body: html }));
  const rects: Record<string, unknown> = {};
  for (const [i, lang] of ORDER.entries()) {
    // One pack enabled at a time (none for English, the app's own language).
    for (const other of ORDER.slice(1)) await msg({ type: 'pack-set-enabled', id: `localhost~${other}`, enabled: other === lang });
    await page.goto(PAGE);
    await page.bringToFront();
    const t = (src: string) => (lang === 'en' ? src : tr.langs[lang]![tr.keys.indexOf(src)]!);
    await expect(page.locator('.snav h1')).toHaveText(t('Settings'), { timeout: 15_000 });
    await expect(page.locator('.foot .primary')).toHaveText(t('Save changes'), { timeout: 15_000 });
    await page.evaluate((l) => document.querySelectorAll('.langs span[data-l]').forEach((s) => s.classList.toggle('on', (s as HTMLElement).dataset.l === l)), lang);
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(FRAMES, `${i}-${lang}.png`) });
    rects[lang] = await page.evaluate(() => {
      const r = document.querySelector('.app')!.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
  }
  writeFileSync(join(FRAMES, 'rects.json'), JSON.stringify(rects));
  await context.close();
});
