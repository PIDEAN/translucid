import type { Page } from '@playwright/test';
import { expect, FIXTURES, runtimeMessage, test } from './extension';

async function tabId(ext: Page, url: string): Promise<number> {
  return ext.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]!.id!, url.split('#')[0]! + '*');
}

test('picking inside an open page menu: the menu stays open, the panel keeps out of the way', async ({ context, ext }) => {
  test.setTimeout(60_000);
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${FIXTURES}/claude-like.html`);
  // The user opens a page menu first (Radix dropdown), then starts picking from the keyboard
  // shortcut (same path as this message: the page keeps focus).
  await page.locator('[data-testid="user-menu-button"]').click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const start = await runtimeMessage(ext, { type: 'pack-collect-start', tabId: await tabId(ext, `${FIXTURES}/claude-like.html`), host: 'localhost', targetLang: 'zh-CN' });
  expect(start.ok).toBe(true);
  const picker = page.locator('translucid-picker');
  await expect(picker.getByText('圈选界面区域')).toBeVisible();

  // Panel buttons do not count as "clicking outside" the menu.
  await picker.getByRole('button', { name: '排除内容' }).click();
  await picker.getByRole('button', { name: '圈选区域' }).click();
  await expect(menu).toBeVisible();

  // Picking the menu itself: selected, and the menu is still there (and nothing was triggered).
  await menu.getByText('Settings').hover();
  await page.keyboard.press('ArrowUp');
  await menu.getByText('Settings').click();
  await expect(menu).toBeVisible();
  await expect(picker.locator('li')).toHaveCount(1);
  expect(new URL(page.url()).hash).toBe('');
  expect(await page.evaluate(() => window.__loggedOut)).toBe(false);

  // Esc pauses picking without closing the menu.
  await page.keyboard.press('Escape');
  await expect(menu).toBeVisible();
  await expect(picker.getByRole('button', { name: '暂停' })).toHaveClass(/on/);

  // While paused the page works normally: a click outside closes the menu as usual.
  await page.mouse.click(700, 500);
  await expect(menu).toHaveCount(0);

  // The panel never covers what is being picked: an element under it makes it move to a free corner.
  await page.keyboard.press('Escape'); // back to picking
  const panel = picker.locator('.panel');
  const box = (await panel.boundingBox())!;
  await page.evaluate(([x, y]) => {
    const d = document.createElement('div');
    d.id = 'under-panel';
    d.textContent = 'Top right widget';
    // Partly visible to the left of the panel, the rest hidden under it.
    Object.assign(d.style, { position: 'fixed', left: `${x}px`, top: `${y}px`, width: '320px', height: '40px', zIndex: '10', background: '#eee' });
    document.body.appendChild(d);
  }, [box.x - 160, box.y + 20]);
  await page.mouse.move(box.x - 300, box.y + 300); // somewhere else first
  await page.mouse.move(box.x - 140, box.y + 40); // the visible part of the element
  await expect(panel).not.toHaveClass(/at-tr/);
  const moved = (await panel.boundingBox())!;
  expect(Math.abs(moved.x - box.x) + Math.abs(moved.y - box.y)).toBeGreaterThan(100);
  // Pointing at the panel itself keeps it where it is (its buttons stay clickable).
  await panel.hover();
  await expect(panel).toHaveClass(new RegExp(`at-${(await panel.getAttribute('class'))!.split('at-')[1]}`));

  // Moving across the page to a panel button, over a row that reaches under the panel, does not chase it away.
  const button = (await picker.getByRole('button', { name: '排除内容' }).boundingBox())!;
  const aim = { x: button.x + button.width / 2, y: button.y + button.height / 2 };
  await page.evaluate((y) => {
    const row = document.createElement('div');
    row.id = 'wide-row';
    row.textContent = 'A settings row as wide as the page';
    Object.assign(row.style, { position: 'fixed', left: '0', top: `${y - 30}px`, width: '100vw', height: '60px', zIndex: '10', background: '#f4f4f4' });
    document.body.appendChild(row);
  }, aim.y);
  const from = { x: aim.x > 640 ? 60 : 1220, y: aim.y + (aim.y > 400 ? -150 : 150) };
  await page.mouse.move(from.x, from.y);
  await page.waitForTimeout(400);
  const corner = (await panel.getAttribute('class'))!.match(/at-\w+/)![0];
  await page.mouse.move(aim.x, aim.y, { steps: 16 });
  await page.mouse.down();
  await page.mouse.up();
  await expect(picker.getByRole('button', { name: '排除内容' })).toHaveClass(/on/);
  await page.waitForTimeout(400);
  await expect(panel).toHaveClass(new RegExp(corner));
});
