// README screenshots in docs/images from test data only: the e2e fixture pages and a made-up demo app,
// never real site content. Run with `pnpm readme:media`.
import { chromium, expect, test } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('../../dist/chrome-mv3', import.meta.url));
const OUT = fileURLToPath(new URL('../images', import.meta.url));
const FIXTURES = 'http://localhost:5300';

const DEMO = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Notara</title>
<style>
*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#24262b;background:#fff}
.app{display:flex;height:100vh}aside{width:248px;padding:18px 12px;background:#f6f7f9;border-right:1px solid #e6e8ec;display:flex;flex-direction:column;gap:4px}
aside button,aside a{all:unset;display:flex;align-items:center;height:32px;padding:0 12px;border-radius:8px;cursor:pointer}
aside .new{background:#e9ebef;height:36px}.label{margin:18px 12px 4px;font-size:12px;color:#80858f}
section[data-testid="recent-list"] a{font-size:13px;color:#5a5f69;height:30px}
main{flex:1;position:relative;background:#f3f4f6}
.dialog{position:absolute;left:70px;top:80px;width:600px;height:460px;background:#fff;border:1px solid #e2e4e9;border-radius:14px;box-shadow:0 12px 32px rgba(20,22,27,.12);display:flex}
.dialog nav{width:180px;padding:20px 12px;border-right:1px solid #eef0f3;display:flex;flex-direction:column;gap:2px}
.dialog nav h2{font-size:17px;margin:0 10px 12px}.dialog nav button{all:unset;height:32px;padding:0 10px;border-radius:8px;cursor:pointer}
.dialog nav button[aria-current="page"]{background:#f1f3f6}
.body{flex:1;padding:24px;display:flex;flex-direction:column;gap:16px}.body h3{margin:0;font-size:16px}
.row{display:flex;flex-direction:column;gap:6px}.row small{color:#80858f}.opts{display:flex;gap:6px}
.opts button{all:unset;padding:6px 12px;border:1px solid #d5d8de;border-radius:8px;cursor:pointer}.opts button[aria-checked="true"]{border-color:#24262b}
</style></head><body><div class="app">
<aside aria-label="Sidebar"><button class="new">New note</button><a href="#inbox">Inbox</a><a href="#reports">Reports</a><a href="#settings">Settings</a>
<div class="label">Recent</div><section data-testid="recent-list"><a href="/note/8f2a">Q3 planning notes</a><a href="/note/91bc">Vendor review</a><a href="/note/a7d0">Weekly sync</a></section></aside>
<main><div class="dialog" role="dialog" aria-label="Settings"><nav aria-label="Settings sections"><h2>Settings</h2>
<button aria-current="page">General</button><button>Account</button><button>Privacy</button><button>Billing</button><button>Integrations</button></nav>
<div class="body"><h3>Appearance</h3>
<div class="row" role="radiogroup" aria-labelledby="ts"><span id="ts">Text size</span><small>Size of text in documents.</small><div class="opts"><button role="radio" aria-checked="false">Small</button><button role="radio" aria-checked="true">Medium</button><button role="radio" aria-checked="false">Large</button></div></div>
<div class="row" role="radiogroup" aria-labelledby="pw"><span id="pw">Page width</span><small>Maximum width of the reading column.</small><div class="opts"><button role="radio" aria-checked="false">Narrow</button><button role="radio" aria-checked="true">Medium</button><button role="radio" aria-checked="false">Wide</button></div></div>
</div></div></main></div></body></html>`;

test('readme screenshots', async () => {
  test.setTimeout(180_000);
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'translucid-shots-')), {
    channel: 'chromium',
    deviceScaleFactor: 2,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extId}/options.html#/config`);
  const msg = (m: unknown) => ext.evaluate((x) => chrome.runtime.sendMessage(x), m) as Promise<any>;
  // A configured provider for the status line, entered the way a user would; nothing is ever sent
  // (this script never generates).
  await ext.getByRole('button', { name: 'DeepSeek 详情' }).click();
  await ext.getByLabel('DeepSeek API Key').fill('demo-key-not-real');
  await ext.getByRole('button', { name: '保存', exact: true }).click();
  await expect(ext.getByText('所有更改已保存')).toBeVisible();

  // Scan the settings fixture, then the workbench review.
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${FIXTURES}/claude-like.html`);
  await page.locator('#open-settings').click();
  await expect(page.getByText('Transcript width')).toBeVisible();
  const tab = await ext.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]!, `${FIXTURES}/claude-like.html*`);
  await msg({ type: 'pack-scan-start', tabId: tab.id, host: 'localhost', targetLang: 'zh-CN', consent: true });
  await expect.poll(async () => (await msg({ type: 'pack-scan-status', tabId: tab.id })).scan?.running, { timeout: 90_000 }).toBe(false);

  const app = await context.newPage();
  await app.setViewportSize({ width: 1280, height: 820 });
  await app.goto(`chrome-extension://${extId}/sites.html#/site/localhost~zh-CN/review`);
  await app.waitForTimeout(800);
  await app.screenshot({ path: `${OUT}/workbench-review.png` });

  // The popup on that page, localization tab.
  const popup = await context.newPage();
  await popup.addInitScript((t) => {
    const q = chrome.tabs.query.bind(chrome.tabs);
    // @ts-expect-error test stub: the popup asks for the active tab
    chrome.tabs.query = (info: chrome.tabs.QueryInfo) => (info.active ? Promise.resolve([t]) : q(info));
  }, tab);
  await popup.setViewportSize({ width: 372, height: 640 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.getByRole('tab', { name: '本地化' }).click();
  await popup.waitForTimeout(900);
  await popup.locator('#app').screenshot({ path: `${OUT}/popup.png` });

  // Config, providers collapsed.
  await app.goto(`chrome-extension://${extId}/options.html#/config`);
  await app.waitForTimeout(800);
  await app.screenshot({ path: `${OUT}/config.png` });

  // The picker on a made-up demo app (served under the fixture origin so content scripts run).
  await page.route(`${FIXTURES}/demo-app.html`, (r) => r.fulfill({ contentType: 'text/html', body: DEMO }));
  await page.goto(`${FIXTURES}/demo-app.html`);
  await page.bringToFront();
  const demoTab = await ext.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]!, `${FIXTURES}/demo-app.html*`);
  await msg({ type: 'pack-collect-start', tabId: demoTab.id, host: 'localhost', targetLang: 'zh-CN' });
  const picker = page.locator('translucid-picker');
  await expect(picker.getByText('圈选界面区域')).toBeVisible();
  await page.locator('aside .new').hover();
  await page.keyboard.press('ArrowUp');
  await page.locator('aside .new').click();
  await picker.getByRole('button', { name: '排除内容' }).click();
  await page.locator('section[data-testid="recent-list"] a').first().hover();
  await page.keyboard.press('ArrowUp');
  await page.locator('section[data-testid="recent-list"] a').first().click();
  await picker.getByRole('button', { name: '圈选区域' }).click();
  await page.locator('.dialog nav button').nth(1).hover();
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/picker.png` });

  await context.close();
});
