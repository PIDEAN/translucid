import type { Page } from '@playwright/test';
import { expect, FIXTURES, runtimeMessage, test, useMockProvider } from './extension';

async function tabId(ext: Page, url: string): Promise<number> {
  return ext.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]!.id!, url.split('#')[0]! + '*');
}

test('site page: review by structure, one confirmation with the full preview, translations by place', async ({ context, ext, extId }) => {
  test.setTimeout(120_000);
  await useMockProvider(ext);
  const page = await context.newPage();
  await page.goto(`${FIXTURES}/claude-like.html`);
  await page.locator('#open-settings').click();
  await expect(page.getByText('Transcript width')).toBeVisible();
  const tab = await tabId(ext, `${FIXTURES}/claude-like.html`);
  expect((await runtimeMessage(ext, { type: 'pack-scan-start', tabId: tab, host: 'localhost', targetLang: 'zh-CN', consent: true })).ok).toBe(true);
  await expect.poll(async () => (await runtimeMessage(ext, { type: 'pack-scan-status', tabId: tab })).scan?.running, { timeout: 90_000 }).toBe(false);

  const sites = await context.newPage();
  await sites.goto(`chrome-extension://${extId}/sites.html#/site/localhost~zh-CN/review`);
  // Grouped by screen › section › question, high-confidence strings pre-checked.
  await expect(sites.getByRole('heading', { name: '对话框 · Settings' })).toBeVisible();
  const width = sites.locator('.st-group', { hasText: 'Transcript width' });
  await expect(width.getByText('Narrow')).toBeVisible();
  await expect(width.locator('.st-item input').first()).toBeChecked();
  // User content never appears; uncertain items are unchecked with a reason.
  await expect(sites.getByText('Summarizes my week for Mira')).toHaveCount(0);
  const enabled = sites.locator('.st-item', { hasText: 'Enabled' });
  await expect(enabled.locator('input')).not.toBeChecked();

  // One confirmation: preview, then send.
  await sites.getByRole('button', { name: /翻译已选的 \d+ 条/ }).click();
  await expect(sites.getByText(/将发送 \d+ 条界面文字/)).toBeVisible();
  await sites.getByRole('button', { name: '确认发送并生成' }).click();
  await expect.poll(async () => (await runtimeMessage(ext, { type: 'pack-job-get', id: 'localhost~zh-CN' })).job?.state, { timeout: 30_000 }).toBe('done');

  // Translations, applied live in the app, with their place.
  await sites.goto(`chrome-extension://${extId}/sites.html#/site/localhost~zh-CN/entries`);
  await expect(sites.getByRole('textbox', { name: /^Transcript width 的译文（文字/ })).toHaveValue('[zh-CN] Transcript width');
  await expect(page.getByText('[zh-CN] Transcript width')).toBeVisible();
  await expect(page.getByText('Mira Chen', { exact: true })).toBeVisible(); // the account name stays as written
});
