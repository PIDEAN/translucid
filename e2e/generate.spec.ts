import { expect, FIXTURES, runtimeMessage, setMockDelay, test, useMockProvider } from './extension';

async function tabId(ext: import('@playwright/test').Page, url: string): Promise<number> {
  return ext.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, url);
}

async function waitJob(ext: import('@playwright/test').Page, id: string, states: string[]) {
  await expect
    .poll(async () => (await runtimeMessage(ext, { type: 'pack-job-get', id })).job?.state, { timeout: 20_000 })
    .toMatch(new RegExp(`^(${states.join('|')})$`));
}

test('pick regions, review, preview exactly what is sent, generate and see it live', async ({ context, ext }) => {
  await setMockDelay(0);
  await useMockProvider(ext);
  const page = await context.newPage();
  await page.goto(`${FIXTURES}/static.html`);
  const id = 'localhost~ja';

  // Popup action: open the picker in the page.
  const start = await runtimeMessage(ext, { type: 'pack-collect-start', tabId: await tabId(ext, `${FIXTURES}/static.html`), host: 'localhost', targetLang: 'ja' });
  expect(start.ok).toBe(true);
  // Approved regions only (no automatic learning): what this test checks is exactly the picked area.
  await runtimeMessage(ext, { type: 'pack-save', pack: { ...start.pack, options: { ...start.pack.options, scope: 'regions', learn: false } } });
  const picker = page.locator('translucid-picker');
  await expect(picker.getByText('圈选界面区域')).toBeVisible();

  // Hover a sidebar button, widen the selection to the whole sidebar with ↑, click (the click does not reach the page).
  await page.locator('#new').hover();
  await page.keyboard.press('ArrowUp');
  await expect(picker.locator('.tag')).toContainText('导航');
  await page.locator('#new').click();
  await expect(picker.locator('li')).toHaveCount(1);
  await picker.getByRole('button', { name: '完成' }).click();
  await expect(picker).toHaveCount(0);

  // Candidates come only from the approved region, personal links flagged.
  await expect.poll(async () => (await runtimeMessage(ext, { type: 'pack-pending-get', id })).pending?.length ?? 0).toBeGreaterThan(2);
  const pending: { key: string; kind: string; src: string; flags: string[] }[] = (await runtimeMessage(ext, { type: 'pack-pending-get', id })).pending;
  const srcs = pending.map((p) => p.src);
  expect(srcs).toContain('New chat');
  expect(srcs).toContain('Open menu'); // aria-label inside the sidebar
  expect(srcs).not.toContain('Search chats'); // the search box sits outside the approved <nav>
  expect(srcs).not.toContain('Copy'); // <main> was not approved
  expect(srcs).not.toContain('settings'); // icon ligature
  expect(srcs).not.toContain('Trip planning with Mira'); // a link to one chat: never collected

  // The user approves only unflagged strings; the preview is the literal request.
  const keys = pending.filter((p) => !p.flags.length).map((p) => p.key);
  const plan = (await runtimeMessage(ext, { type: 'pack-plan', id, keys, description: 'A chat app' })).plan;
  const sent = JSON.stringify(plan.messages);
  expect(plan.destination).toMatchObject({ name: 'Mock LLM', baseURL: 'http://localhost:5301/v1' });
  expect(sent).toContain('New chat');
  expect(sent).toContain('A chat app');
  expect(sent).not.toContain('Trip planning with Mira');
  expect(sent).not.toContain('static.html'); // no page URL or title

  // Generation runs the frozen preview only.
  await fetch('http://localhost:5301/control?reset=1');
  expect((await runtimeMessage(ext, { type: 'pack-generate', id, planId: 'forged' })).ok).toBe(false);
  const gen = await runtimeMessage(ext, { type: 'pack-generate', id, planId: plan.planId });
  expect(gen.ok).toBe(true);
  await waitJob(ext, id, ['done']);
  // What the model server actually received (service-worker traffic included) equals the preview.
  const received: { messages: unknown }[] = await (await fetch('http://localhost:5301/requests')).json();
  expect(received.map((r) => r.messages)).toEqual(plan.messages);
  expect(JSON.stringify(received)).not.toContain('Trip planning with Mira');
  // Applied live in the open tab.
  await expect(page.locator('#new')).toHaveText('[ja] New chat');
  await expect(page.locator('#menu')).toHaveAttribute('aria-label', '[ja] Open menu');
  await expect(page.locator('#conv')).toHaveText('Trip planning with Mira'); // flagged, so never sent
  await expect(page.locator('#search')).toHaveAttribute('placeholder', 'Search chats');

  // A reload shows the translation without another model request (checked at the server).
  expect(await (await fetch('http://localhost:5301/control?delay=0&reset=1')).text()).toBe('ok');
  await page.reload();
  await expect(page.locator('#new')).toHaveText('[ja] New chat');
  await page.waitForTimeout(500);
  expect(await (await fetch('http://localhost:5301/requests')).json()).toEqual([]);
});

test('a job interrupted by a service-worker restart pauses and resumes on request', async ({ context, ext }) => {
  await useMockProvider(ext);
  const page = await context.newPage();
  await page.goto(`${FIXTURES}/static.html`);
  const id = 'localhost~de';
  await runtimeMessage(ext, { type: 'pack-collect-start', tabId: await tabId(ext, `${FIXTURES}/static.html`), host: 'localhost', targetLang: 'de' });
  await page.locator('#new').hover();
  await page.keyboard.press('ArrowUp');
  await page.locator('#new').click();
  await page.locator('translucid-picker').getByRole('button', { name: '完成' }).click();
  await expect.poll(async () => (await runtimeMessage(ext, { type: 'pack-pending-get', id })).pending?.length ?? 0).toBeGreaterThan(2);
  const pending: { key: string; kind: string; src: string; flags: string[] }[] = (await runtimeMessage(ext, { type: 'pack-pending-get', id })).pending;
  const keys = pending.filter((p) => !p.flags.length).map((p) => p.key);

  await setMockDelay(4000);
  const { plan } = await runtimeMessage(ext, { type: 'pack-plan', id, keys, description: '' });
  await runtimeMessage(ext, { type: 'pack-generate', id, planId: plan.planId });
  await waitJob(ext, id, ['running']);
  // Kill the service worker mid-request, as Chrome does with idle or crashed workers.
  const cdp = await context.newCDPSession(ext);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await setMockDelay(0);
  const ext2 = ext;
  // The next message wakes a fresh worker, which marks the interrupted job as paused.
  await waitJob(ext2, id, ['paused']);
  expect(await page.locator('#new').textContent()).toBe('New chat'); // nothing applied yet

  const r = await runtimeMessage(ext2, { type: 'pack-job-resume', id });
  expect(r.ok).toBe(true);
  await waitJob(ext2, id, ['done']);
  await page.reload();
  await expect(page.locator('#new')).toHaveText('[de] New chat');
});
