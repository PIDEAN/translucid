import type { Page } from '@playwright/test';
import { expect, FIXTURES, runtimeMessage, test, useMockProvider } from './extension';

/** Tab showing `url` (match patterns cannot contain a #fragment, so it is ignored). */
async function tabId(ext: Page, url: string): Promise<number> {
  return ext.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]!.id!, url.split('#')[0]! + '*');
}

type Pending = { key: string; src: string; ctx?: string; where?: { group?: string }; tier: string }[];

async function scanAndWait(ext: Page, tab: number, consent = true) {
  const start = await runtimeMessage(ext, { type: 'pack-scan-start', tabId: tab, host: 'localhost', targetLang: 'zh-CN', consent });
  if (!start.ok) return start;
  await expect.poll(async () => (await runtimeMessage(ext, { type: 'pack-scan-status', tabId: tab })).scan?.running, { timeout: 90_000 }).toBe(false);
  return runtimeMessage(ext, { type: 'pack-scan-status', tabId: tab, packId: 'localhost~zh-CN' });
}

test('one-click scan explores every settings section and popup, changes nothing, restores the page', async ({ context, ext }) => {
  test.setTimeout(120_000);
  const page = await context.newPage();
  await page.goto(`${FIXTURES}/claude-like.html`);
  // The user opens settings, then asks for a scan.
  await page.locator('#open-settings').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('Transcript width')).toBeVisible();
  const tab = await tabId(ext, `${FIXTURES}/claude-like.html#settings/general`);

  // First scan of a site needs consent.
  expect((await runtimeMessage(ext, { type: 'pack-scan-start', tabId: tab, host: 'localhost', targetLang: 'zh-CN' })).error).toBe('need-consent');
  const status = await scanAndWait(ext, tab);
  const report = status.scan.last.report;
  expect(report.guard).toBeUndefined();
  expect(report.restore).toBe('full');
  expect(report.visited).toEqual(expect.arrayContaining(['Account', 'Privacy', 'Billing', 'Capabilities', 'Skills', 'Serif', 'Engineering', 'Invoices', 'Payment']));
  expect(report.skipped).toContainEqual({ label: 'Delete account', reason: '可能执行操作' });

  // Nothing was changed, clicked or signed out; the page is back where the user left it.
  expect(await page.evaluate(() => [window.__changed, window.__danger, window.__loggedOut])).toEqual([false, false, false]);
  await expect(page.locator('[data-testid="general-settings"] button')).toHaveAttribute('aria-current', 'page');
  expect(new URL(page.url()).hash).toBe('#settings/general');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('translucid-scan')).toHaveCount(0);

  // Strings from every section and popup, with structure; user content never collected.
  const pending: Pending = (await runtimeMessage(ext, { type: 'pack-pending-get', id: 'localhost~zh-CN' })).pending;
  const srcs = pending.map((p) => p.src);
  for (const s of ['Transcript width', 'Size of text in the transcript.', 'Design', 'Product management', 'Dyslexic friendly', 'Location metadata', 'Past invoices appear here.', 'Response length', 'Your skills', 'More options']) {
    expect(srcs).toContain(s);
  }
  for (const s of ['Mira Chen', 'MC', 'mira.chen@example.org', 'weekly-digest', 'Summarizes my week for Mira', 'Trip planner', 'Plans the Lisbon trip', 'Trip planning with Mira']) {
    expect(srcs).not.toContain(s);
  }
  // "Medium" answers three different questions: three occurrences, each with its group.
  const medium = pending.filter((p) => p.src === 'Medium');
  expect(medium.map((m) => m.where?.group).sort()).toEqual(['Response length', 'Transcript text size', 'Transcript width']);
  expect(new Set(medium.map((m) => m.ctx)).size).toBe(3);
  // The occupation value travels with its question.
  expect(pending.find((p) => p.src === 'Engineering')!.where?.group).toBe('What best describes your work?');
});

test('the structured preview sends each answer with its question', async ({ context, ext }) => {
  test.setTimeout(120_000);
  await useMockProvider(ext);
  const page = await context.newPage();
  await page.goto(`${FIXTURES}/claude-like.html`);
  await page.locator('#open-settings').click();
  await expect(page.getByText('Transcript width')).toBeVisible();
  await scanAndWait(ext, await tabId(ext, `${FIXTURES}/claude-like.html#settings/general`));
  const pending: Pending = (await runtimeMessage(ext, { type: 'pack-pending-get', id: 'localhost~zh-CN' })).pending;
  const keys = pending.filter((p) => p.tier === 'high').map((p) => p.key);
  const { plan } = await runtimeMessage(ext, { type: 'pack-plan', id: 'localhost~zh-CN', keys, description: 'An AI assistant' });
  const user = plan.messages.map((m: { content: string }[]) => m[1]!.content).join('\n');
  // Each answer sits under its question, in page order (other lines of the group may come between).
  const line = String.raw`(?:\n\s+\w+ <\d+>[^<]*<\/\d+>)*`;
  expect(user).toMatch(new RegExp(String.raw`radios <\d+>Transcript width<\/\d+>${line}\n\s+opt <\d+>Narrow<\/\d+>\n\s+opt <\d+>Medium<\/\d+>\n\s+opt <\d+>Wide<\/\d+>`));
  expect(user).toMatch(new RegExp(String.raw`select <\d+>What best describes your work\?<\/\d+>${line}\n\s+value <\d+>Engineering<\/\d+>`));
  // The font menu answers "Chat font", not its current value.
  expect(user).toMatch(/select "Chat font"|group <\d+>Chat font<\/\d+>/);
  // Its options sit under that question too, even though Radix portals the menu elsewhere.
  expect(user).toMatch(new RegExp(String.raw`group <\d+>Chat font<\/\d+>${line}\n\s+menuitem <\d+>Sans<\/\d+>`));
  expect(user).not.toContain('Mira');
});

test('refuses to scan over unsaved input, and stops on request', async ({ context, ext }) => {
  test.setTimeout(120_000);
  const page = await context.newPage();
  await page.goto(`${FIXTURES}/claude-like.html#settings/account`);
  const name = page.getByLabel('Full name');
  await expect(name).toBeVisible();
  await name.fill('Mira C');
  const tab = await tabId(ext, `${FIXTURES}/claude-like.html#settings/account`);
  const refused = await scanAndWait(ext, tab);
  expect(refused.scan.last.refused).toBe('draft');
  expect(await name.inputValue()).toBe('Mira C');

  // Clean state: start, then stop almost immediately; the page comes back.
  await page.reload();
  await expect(page.getByLabel('Full name')).toBeVisible();
  const tab2 = await tabId(ext, `${FIXTURES}/claude-like.html#settings/account`);
  expect((await runtimeMessage(ext, { type: 'pack-scan-start', tabId: tab2, host: 'localhost', targetLang: 'zh-CN', consent: true })).ok).toBe(true);
  await page.waitForTimeout(700);
  await runtimeMessage(ext, { type: 'pack-scan-cancel', tabId: tab2 });
  await expect.poll(async () => (await runtimeMessage(ext, { type: 'pack-scan-status', tabId: tab2 })).scan?.running, { timeout: 30_000 }).toBe(false);
  const st = await runtimeMessage(ext, { type: 'pack-scan-status', tabId: tab2, packId: 'localhost~zh-CN' });
  expect(st.scan.last.report.stopped).toBe(true);
  expect(new URL(page.url()).hash).toBe('#settings/account');
  expect(await page.evaluate(() => [window.__changed, window.__danger])).toEqual([false, false]);
});

test('user clicks are blocked during a scan (the overlay keeps the page untouched)', async ({ context, ext }) => {
  test.setTimeout(120_000);
  const page = await context.newPage();
  await page.goto(`${FIXTURES}/claude-like.html#settings/privacy`);
  await expect(page.getByText('Location metadata').first()).toBeVisible();
  const tab = await tabId(ext, `${FIXTURES}/claude-like.html#settings/privacy`);
  expect((await runtimeMessage(ext, { type: 'pack-scan-start', tabId: tab, host: 'localhost', targetLang: 'zh-CN', consent: true })).ok).toBe(true);
  await expect(page.locator('translucid-scan')).toHaveCount(1);
  await page.mouse.click(10, 10);
  await page.keyboard.press('Space');
  await page.keyboard.press('Escape'); // Esc stops the scan
  await expect.poll(async () => (await runtimeMessage(ext, { type: 'pack-scan-status', tabId: tab })).scan?.running, { timeout: 30_000 }).toBe(false);
  expect(await page.evaluate(() => window.__changed)).toBe(false);
});

test('hub-and-subpage apps: routed sub-pages are visited, sessions never, full page loads cancelled', async ({ context, ext }) => {
  test.setTimeout(120_000);
  const page = await context.newPage();
  await page.goto(`${FIXTURES}/devin-like.html`);
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  const tab = await tabId(ext, `${FIXTURES}/org/acme/settings`);
  const status = await scanAndWait(ext, tab);
  const report = status.scan.last.report;
  expect(report.visited).toEqual(expect.arrayContaining(['Members', 'Billing', 'Integrations', 'Help']));
  expect(report.skipped).toContainEqual({ label: 'Legacy settings', reason: '会重新加载页面' });
  expect(await page.evaluate(() => window.__visited.some((p) => p.includes('/sessions/')))).toBe(false);
  expect(new URL(page.url()).pathname).toBe('/org/acme/settings');
  const srcs = ((await runtimeMessage(ext, { type: 'pack-pending-get', id: 'localhost~zh-CN' })).pending as Pending).map((p) => p.src);
  for (const s of ['Invite teammates and manage roles.', 'Connect source control and chat tools.', 'Documentation', 'Keyboard shortcuts']) expect(srcs).toContain(s);
  expect(srcs).not.toContain('Fix login redirect for Mira');
  expect(srcs).not.toContain('acme');
});

test('a scan cut short by a page reload is reported as interrupted, never stuck on "scanning"', async ({ context, ext }) => {
  test.setTimeout(120_000);
  const page = await context.newPage();
  await page.goto(`${FIXTURES}/claude-like.html#settings/general`);
  await expect(page.getByText('Transcript width')).toBeVisible();
  const tab = await tabId(ext, `${FIXTURES}/claude-like.html`);
  expect((await runtimeMessage(ext, { type: 'pack-scan-start', tabId: tab, host: 'localhost', targetLang: 'zh-CN', consent: true })).ok).toBe(true);
  await page.waitForTimeout(600);
  await page.reload();
  const st = await runtimeMessage(ext, { type: 'pack-scan-status', tabId: tab, packId: 'localhost~zh-CN' });
  expect(st.scan.running).toBe(false);
  expect(st.scan.last.refused).toBe('interrupted');
});
