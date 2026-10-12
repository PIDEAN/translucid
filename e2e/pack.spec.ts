import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, FIXTURES, fixturePack, runtimeMessage, tabMessage, test } from './extension';

test('saving a pack registers the runtime script for its host only', async ({ ext, sw }) => {
  const res = await runtimeMessage(ext, { type: 'pack-save', pack: fixturePack() });
  expect(res.ok).toBe(true);
  const scripts = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  expect(scripts).toHaveLength(1);
  expect(scripts[0]).toMatchObject({ id: 'translucid-pack', matches: ['*://localhost/*'], runAt: 'document_start' });

  // Disabling unregisters; enabling again re-registers (differential reconciliation).
  await runtimeMessage(ext, { type: 'pack-set-enabled', id: 'localhost~zh-CN', enabled: false });
  expect(await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts())).toHaveLength(0);
  await runtimeMessage(ext, { type: 'pack-set-enabled', id: 'localhost~zh-CN', enabled: true });
  expect(await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts())).toHaveLength(1);
});

test('web pages cannot write packs', async ({ context, ext }) => {
  await runtimeMessage(ext, { type: 'pack-save', pack: fixturePack() });
  const page = await context.newPage();
  await page.goto(`${FIXTURES}/static.html`);
  // A content script (or a page that compromised one) is not an extension page.
  const res = await ext.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab!.id! },
      func: () => chrome.runtime.sendMessage({ type: 'pack-delete', id: 'localhost~zh-CN' }),
    });
    return r!.result;
  }, `${FIXTURES}/static.html`);
  expect(res).toMatchObject({ ok: false });
});

test('applies in place, respects privacy rules, toggles and restores', async ({ context, ext }) => {
  await runtimeMessage(ext, { type: 'pack-save', pack: fixturePack() });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${FIXTURES}/static.html`);

  await expect(page.locator('#new')).toHaveText('新建对话');
  await expect(page.locator('#settings')).toHaveText('设置');
  await expect(page.locator('#search')).toHaveAttribute('placeholder', '搜索对话');
  await expect(page.locator('#menu')).toHaveAttribute('aria-label', '打开菜单');
  await expect(page.locator('#menu')).toHaveAttribute('title', '分享');
  await expect(page.locator('#send')).toHaveAttribute('value', '发送');
  await expect(page.locator('#copy')).toHaveText('复制'); // control label inside user content
  await expect(page.locator('#msg')).toHaveText('Settings'); // user content untouched
  await expect(page.locator('#code')).toHaveText('Settings');
  await expect(page.locator('#menu .material-icons')).toHaveText('settings'); // icon ligature untouched
  await expect(page.locator('#conv')).toHaveText('Trip planning with Mira');

  const off = await tabMessage(ext, `${FIXTURES}/static.html`, { type: 'pack-toggle', on: false });
  expect(off).toMatchObject({ injected: true, active: false });
  await expect(page.locator('#new')).toHaveText('New chat');
  await expect(page.locator('#search')).toHaveAttribute('placeholder', 'Search chats');
  await tabMessage(ext, `${FIXTURES}/static.html`, { type: 'pack-toggle', on: true });
  await expect(page.locator('#new')).toHaveText('新建对话');

  // Deleting the pack restores open pages live.
  await runtimeMessage(ext, { type: 'pack-delete', id: 'localhost~zh-CN' });
  await expect(page.locator('#new')).toHaveText('New chat');
  expect(errors).toEqual([]);
});

test('React re-renders and recycled list rows stay translated', async ({ context, ext }) => {
  await runtimeMessage(ext, { type: 'pack-save', pack: fixturePack() });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${FIXTURES}/react.html`);

  await expect(page.locator('#inc')).toHaveText('设置');
  await page.locator('#inc').click();
  await page.locator('#inc').click();
  await expect(page.locator('#count')).toHaveText('2'); // app still works
  await expect(page.locator('#inc')).toHaveText('设置');

  await page.locator('#swap').click(); // React writes a new string into the same text node
  await expect(page.locator('#swap')).toHaveText('设置');
  await page.locator('#swap').click();
  await expect(page.locator('#swap')).toHaveText('新建对话');

  await expect(page.locator('#rows li').first()).toHaveText('归档');
  await page.locator('#scroll').click();
  await expect(page.locator('#rows li').first()).toHaveText('重命名');
  await expect(page.locator('#rows li')).toHaveText(['重命名', '删除', '归档', '重命名', '删除', '归档']);
  expect(errors).toEqual([]);
});

test('server-rendered pages are left alone until hydration settles', async ({ context, ext }) => {
  await runtimeMessage(ext, { type: 'pack-save', pack: fixturePack() });
  const page = await context.newPage();
  await page.goto(`${FIXTURES}/ssr.html`);
  await expect(page.locator('#inc')).toHaveText('设置');
  expect(await page.evaluate(() => window.__hydrated)).toBe(true);
  expect(await page.evaluate(() => window.__hydrationErrors)).toEqual([]);
  await page.locator('#inc').click();
  await expect(page.locator('#count')).toHaveText('1');
  await expect(page.locator('#inc')).toHaveText('设置');
});

test('open shadow roots are translated, including later additions', async ({ context, ext }) => {
  await runtimeMessage(ext, { type: 'pack-save', pack: fixturePack() });
  const page = await context.newPage();
  await page.goto(`${FIXTURES}/shadow.html`);
  await expect(page.locator('#toolbar #new')).toHaveText('新建对话');
  await expect(page.locator('#toolbar #search')).toHaveAttribute('placeholder', '搜索对话');
  await expect(page.locator('#toolbar #late')).toHaveText('设置');
});

test('pages opened before the pack existed pick it up without a reload', async ({ context, ext }) => {
  const page = await context.newPage();
  await page.goto(`${FIXTURES}/static.html`);
  await expect(page.locator('#new')).toHaveText('New chat');
  await runtimeMessage(ext, { type: 'pack-save', pack: fixturePack() });
  await expect(page.locator('#new')).toHaveText('新建对话');
  // A new revision applies live.
  const edited = fixturePack({
    entries: [{ kind: 'text', src: 'New chat', t: '开始新对话', status: 'edited' }],
  });
  await runtimeMessage(ext, { type: 'pack-save', pack: edited });
  await expect(page.locator('#new')).toHaveText('开始新对话');
});

test('production build ships no debug bridge', async () => {
  const dir = fileURLToPath(new URL('../dist/chrome-mv3', import.meta.url));
  const files = ['background.js', ...readdirSync(join(dir, 'content-scripts')).map((f) => `content-scripts/${f}`)];
  for (const f of files.filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    expect(src, f).not.toContain('xtDebug');
    expect(src, f).not.toContain('data-xt-debug');
  }
});
