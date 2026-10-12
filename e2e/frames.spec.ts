import type { BrowserContext, Page } from '@playwright/test';
import { expect, FIXTURES, tabMessage, test, useMockProvider } from './extension';

/** The real popup, as if opened from the toolbar while the tab showing `url` is active. */
async function openPopup(context: BrowserContext, extId: string, ext: Page, url: string): Promise<Page> {
  const tab = await ext.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]!, `${url.split('?')[0]}*`);
  const popup = await context.newPage();
  await popup.addInitScript((t) => {
    localStorage.setItem('translucid.popup.tab', 'page');
    const query = chrome.tabs.query.bind(chrome.tabs);
    // @ts-expect-error test stub: the popup asks for the active tab
    chrome.tabs.query = (info: chrome.tabs.QueryInfo) => (info.active ? Promise.resolve([t]) : query(info));
  }, tab);
  await popup.setViewportSize({ width: 372, height: 640 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  return popup;
}

const progressOf = async (popup: Page) => {
  const text = (await popup.getByText(/^\d+ \/ \d+ 段$/).textContent())!;
  const [done, segments] = text.match(/\d+/g)!.map(Number);
  return { done: done!, segments: segments! };
};

async function openFramesPage(context: BrowserContext, query = ''): Promise<{ page: Page; url: string }> {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  const url = `${FIXTURES}/frames.html${query}`;
  await page.goto(url);
  await expect(page.frameLocator('#article').getByRole('heading').first()).toBeVisible();
  await page.waitForLoadState('load');
  return { page, url };
}

async function setAutoTranslate(ext: Page, on: boolean): Promise<void> {
  await ext.evaluate(async (v) => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, autoTranslate: v } });
  }, on);
}

test('a page whose body is a cross-origin frame is translated as one page; ad-sized frames are left alone', async ({ context, ext, extId }) => {
  test.setTimeout(60_000);
  await useMockProvider(ext);
  const { page, url } = await openFramesPage(context);
  const article = page.frameLocator('#article');

  const popup = await openPopup(context, extId, ext, url);
  await popup.locator('.pp-big-primary').click();

  // Every paragraph of the framed article gets its translation; the ad frame is never read.
  await expect(article.locator('xt-trans[data-state="done"]')).toHaveCount(5);
  await expect(article.locator('xt-trans').first()).toContainText('Notes that follow your work');
  await expect(page.frameLocator('#ad').locator('xt-trans')).toHaveCount(0);

  // The popup counts the frame's paragraphs together with the top document's.
  await expect.poll(async () => progressOf(popup), { timeout: 10_000 }).toMatchObject({ done: 6, segments: 6 });
  await expect(popup.getByText('可见区域已翻译')).toBeVisible();

  // The frame moves to another page: the new document keeps the choice made for the tab.
  await page.frame({ url: /frame-article\.html/ })!.goto('http://127.0.0.1:5300/frame-article-2.html');
  await expect(article.getByRole('heading', { name: 'The next page in the same frame' })).toBeVisible();
  await expect(article.locator('xt-trans[data-state="done"]')).toHaveCount(3);

  // Turning it off from the popup restores every document.
  await popup.reload();
  await popup.getByRole('button', { name: /显示原文/ }).click();
  await expect(article.locator('xt-trans')).toHaveCount(0);
  await expect(page.locator('header xt-trans')).toHaveCount(0);
});

test('quick page commands (as from Alt+A / Alt+S) leave every document in step', async ({ context, ext, extId }) => {
  test.setTimeout(60_000);
  await useMockProvider(ext);
  const { page, url } = await openFramesPage(context);
  const article = page.frameLocator('#article');
  const popup = await openPopup(context, extId, ext, url);
  await popup.locator('.pp-big-primary').click();
  await expect(article.locator('xt-trans[data-state="done"]')).toHaveCount(5);
  // Twice each, as fast as the keyboard: page commands go to the top document, frames follow its intent.
  const twice = (cmd: unknown) =>
    ext.evaluate(async ([u, c]) => {
      const [tab] = await chrome.tabs.query({ url: u as string });
      await Promise.all([chrome.tabs.sendMessage(tab!.id!, c, { frameId: 0 }), chrome.tabs.sendMessage(tab!.id!, c, { frameId: 0 })]);
    }, [`${url}*`, cmd] as const);
  const frameMode = () => page.frame({ url: /frame-article\.html/ })!.evaluate(() => document.documentElement.classList.contains('xt-replace'));
  await twice({ type: 'toggle-mode' });
  // Sent past the popup on purpose: the open popup's state reads bring the frame in step.
  await expect.poll(frameMode, { timeout: 5000 }).toBe(false);
  expect(await page.evaluate(() => document.documentElement.classList.contains('xt-replace'))).toBe(false);
  await twice({ type: 'toggle' });
  await page.waitForTimeout(500);
  await expect(article.locator('xt-trans[data-state="done"]')).toHaveCount(5);
  await expect(page.locator('header xt-trans[data-state="done"]')).toHaveCount(1);
});

test('a frame that missed an update catches up without another action', async ({ context, ext, extId }) => {
  test.setTimeout(60_000);
  await useMockProvider(ext);
  const { page, url } = await openFramesPage(context);
  const article = page.frameLocator('#article');
  let popup = await openPopup(context, extId, ext, url);
  await popup.locator('.pp-big-primary').click();
  await expect(article.locator('xt-trans[data-state="done"]')).toHaveCount(5);
  await popup.close();
  // 显示原文 reaches the top document, but the update for the frame is lost on the way.
  await ext.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    await chrome.tabs.sendMessage(tab!.id!, { type: 'set-enabled', enabled: false }, { frameId: 0 });
  }, `${url}*`);
  await expect(page.locator('header xt-trans')).toHaveCount(0);
  await page.waitForTimeout(500);
  await expect(article.locator('xt-trans[data-state="done"]')).toHaveCount(5);
  // Just looking at the page state (the popup) brings the frame in step.
  popup = await openPopup(context, extId, ext, url);
  await expect(article.locator('xt-trans')).toHaveCount(0);
  await expect(popup.locator('.pp-big-primary')).toBeVisible();
});

test('auto-translate covers the top document only; frames join when asked, and stay off after 显示原文', async ({ context, ext, extId }) => {
  test.setTimeout(60_000);
  await useMockProvider(ext);
  await setAutoTranslate(ext, true);
  const { page, url } = await openFramesPage(context);
  const article = page.frameLocator('#article');

  // The top document translated itself; the embedded page did not.
  await expect(page.locator('header xt-trans[data-state="done"]')).toHaveCount(1);
  await page.waitForTimeout(800);
  await expect(article.locator('xt-trans')).toHaveCount(0);

  // The popup shows the page as translated (显示原文 restores it) and offers the embedded page.
  const popup = await openPopup(context, extId, ext, url);
  await expect(popup.getByText('内嵌页面里还有约 5 段未翻译')).toBeVisible();
  await expect(popup.getByRole('button', { name: /显示原文/ })).toBeVisible();
  await popup.getByRole('button', { name: '翻译内嵌页面' }).click();
  await expect(article.locator('xt-trans[data-state="done"]')).toHaveCount(5);
  await expect(popup.getByText(/内嵌页面里还有/)).toBeHidden();

  // Off for the page: a frame navigating afterwards does not translate itself again.
  await popup.getByRole('button', { name: /显示原文/ }).click();
  await expect(article.locator('xt-trans')).toHaveCount(0);
  await page.frame({ url: /frame-article\.html/ })!.goto('http://127.0.0.1:5300/frame-article-2.html');
  await expect(article.getByRole('heading', { name: 'The next page in the same frame' })).toBeVisible();
  await page.waitForTimeout(800);
  await expect(article.locator('xt-trans')).toHaveCount(0);
});

test('a page-sized frame with sign-in fields is never translated, even when the user asks for the page', async ({ context, ext, extId }) => {
  test.setTimeout(60_000);
  await useMockProvider(ext);
  const { page, url } = await openFramesPage(context, '?frame=frame-login.html');
  const login = page.frameLocator('#article');
  await expect(login.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();

  const popup = await openPopup(context, extId, ext, url);
  await popup.locator('.pp-big-primary').click();
  // The top document is translated and the popup shows the page as done; the sign-in frame stays untouched.
  await expect(page.locator('header xt-trans[data-state="done"]')).toHaveCount(1);
  await expect.poll(async () => progressOf(popup), { timeout: 10_000 }).toMatchObject({ done: 1, segments: 1 });
  await page.waitForTimeout(800);
  await expect(login.locator('xt-trans')).toHaveCount(0);
});

test('sign-in fields appearing in a translating frame stop it, and nothing restarts it', async ({ context, ext, extId }) => {
  test.setTimeout(60_000);
  await useMockProvider(ext);
  const { page, url } = await openFramesPage(context);
  const article = page.frameLocator('#article');
  const popup = await openPopup(context, extId, ext, url);
  await popup.locator('.pp-big-primary').click();
  await expect(article.locator('xt-trans[data-state="done"]')).toHaveCount(5);

  // The app inside the frame shows a sign-in form (no autocomplete hints, recognized by its field names).
  await page.frame({ url: /frame-article\.html/ })!.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<form><p>Confirm it is you to keep reading this article.</p><input name="otp" inputmode="numeric"></form>');
  });
  await expect(article.locator('xt-trans')).toHaveCount(0);

  // Nothing turns it back on: not the popup, not a new expert (which restarts translation internally).
  await tabMessage(ext, url, { type: 'set-expert', expertId: 'tech' });
  await tabMessage(ext, url, { type: 'set-enabled', enabled: true });
  await page.waitForTimeout(800);
  await expect(article.locator('xt-trans')).toHaveCount(0);
  await expect(page.locator('header xt-trans[data-state="done"]')).toHaveCount(1);
});

test('a page with nothing to translate says so instead of waiting for a scroll', async ({ context, ext, extId }) => {
  await useMockProvider(ext);
  const page = await context.newPage();
  const url = `${FIXTURES}/chinese.html`;
  await page.goto(url);
  await page.waitForLoadState('load');
  await tabMessage(ext, url, { type: 'set-enabled', enabled: true });
  const popup = await openPopup(context, extId, ext, url);
  await expect(popup.getByText('这个页面没有找到可翻译的文字')).toBeVisible();
  await expect(popup.getByText('等待页面滚动')).toHaveCount(0);
});
