// Captures for the README videos, one fresh browser profile per scene. Everything on screen is the real
// extension working on made-up pages (notara.html, journal.html); translations come from hand-written text
// (notara-translations.json, zh-dictionary.json via mock-translate.mjs), never a real model or site.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boxOf, centre, HERE, launch, openPopup, Recorder, serve, tabOf, useMediaTranslator } from './lib';

const notara = readFileSync(join(HERE, 'notara.html'), 'utf8');
const journal = readFileSync(join(HERE, 'journal.html'), 'utf8');
const tr = JSON.parse(readFileSync(join(HERE, 'notara-translations.json'), 'utf8')) as { keys: string[]; langs: Record<string, string[]> };
const HOST = 'app.notara.example';
const NOTARA = `https://${HOST}/settings`;
const JOURNAL = 'https://journal.notara.example/write-in-your-language';
/** As shown in the address bar. */
const URL_NOTARA = NOTARA.replace('https://', '');
const URL_JOURNAL = JOURNAL.replace('https://', '');
const PACK = `${HOST}~zh-CN`;
/** The extension's toolbar icon (the video draws the toolbar). */
const TOOLBAR = { x: 0, y: 0, on: 'toolbar' as const };

test.describe.configure({ mode: 'serial', timeout: 240_000 });

test('languages: the same app in seven languages', async () => {
  const x = await launch();
  const ORDER = ['en', 'zh-CN', 'ja', 'es', 'de', 'fr', 'ko'];
  const LABEL: Record<string, string> = { en: 'English', 'zh-CN': '简体中文', ja: '日本語', es: 'Español', de: 'Deutsch', fr: 'Français', ko: '한국어' };
  for (const lang of ORDER.slice(1)) {
    const values = tr.langs[lang]!;
    const pack = {
      format: 'translucid-site-pack', version: 1,
      site: { hosts: [HOST], scopes: ['/'], name: 'Notara', description: 'A notes app' },
      regions: [], sourceLang: 'en', targetLang: lang, glossary: [], excludes: [],
      entries: tr.keys.map((src, i) => ({ kind: src === 'Search notes' ? 'placeholder' : 'text', src, t: values[i]!, status: 'auto' })),
      options: { hydration: 'immediate' }, generator: { model: 'hand-written', promptVersion: 1, createdAt: 0, updatedAt: 0 }, rev: 0,
    };
    expect((await x.msg<{ ok: boolean }>({ type: 'pack-save', pack, enabled: false })).ok).toBe(true);
  }
  const page = await x.context.newPage();
  const url = await serve(page, NOTARA, notara);
  const rec = new Recorder('languages');
  for (const [i, lang] of ORDER.entries()) {
    for (const other of ORDER.slice(1)) await x.msg({ type: 'pack-set-enabled', id: `${HOST}~${other}`, enabled: other === lang });
    await page.goto(url);
    await page.bringToFront();
    const t = (src: string) => (lang === 'en' ? src : tr.langs[lang]![tr.keys.indexOf(src)]!);
    await expect(page.locator('.snav h1')).toHaveText(t('Settings'));
    await expect(page.locator('.foot .primary')).toHaveText(t('Save changes'));
    await page.waitForTimeout(200);
    await rec.page(page, { dur: i === 0 ? 2000 : 1500, enter: i === 0 ? 'cut' : 'sweep', lang: LABEL[lang], url: URL_NOTARA });
  }
  rec.save({ langs: ORDER.map((l) => LABEL[l]), loop: 'sweep' });
  await x.context.close();
});

test('scan, review, generate: one click to a localized app', async () => {
  const x = await launch();
  await useMediaTranslator(x.ext);
  const page = await x.context.newPage();
  const url = await serve(page, NOTARA, notara);
  await page.goto(url);
  const tab = await tabOf(x.ext, url);

  // 1. The popup on the app: one click.
  const scan = new Recorder('scan');
  let popup = await openPopup(x, tab, 'site');
  let pop = await scan.popup(popup, { go: 'button.btn-primary.btn-lg' });
  await popup.close();
  await page.bringToFront();
  const cap1 = '打开网站，点扩展图标 →「一键本地化此站点」';
  await scan.page(page, { dur: 1300, enter: 'cut', url: URL_NOTARA, cursor: TOOLBAR, click: true, caption: cap1 });
  await scan.page(page, { dur: 700, popup: pop.img, url: URL_NOTARA, caption: cap1 });
  await scan.page(page, { dur: 900, popup: pop.img, cursor: { ...centre(pop.boxes.go!), on: 'popup' }, click: true, url: URL_NOTARA, caption: cap1 });

  // 2. The real scan, frame by frame: sections and menus open, nothing changes, the page is restored.
  const done = x.msg({ type: 'pack-scan-start', tabId: tab.id, host: HOST, targetLang: 'zh-CN', consent: true });
  const until = Date.now() + 60_000;
  let frames = 0;
  while (Date.now() < until) {
    const st = await x.msg<{ scan?: { running?: boolean } }>({ type: 'pack-scan-status', tabId: tab.id });
    if (frames > 2 && !st.scan?.running) break;
    // Played at double speed in the video (frames are about 160 ms apart in real time).
    await scan.page(page, { dur: 80, speed: 2, enter: 'cut', url: URL_NOTARA, caption: '自动打开设置分区和菜单收集界面文字，不改任何设置' });
    frames++;
    await page.waitForTimeout(60);
  }
  await done;
  await page.waitForTimeout(400);
  popup = await openPopup(x, tab, 'site');
  pop = await scan.popup(popup, { review: '.btn-amber' });
  await popup.close();
  await page.bringToFront();
  const cap3 = '扫描结束，页面恢复原状；找到的文字等你审核';
  await scan.page(page, { dur: 900, enter: 'fade', url: URL_NOTARA, cursor: TOOLBAR, click: true, caption: cap3 });
  await scan.page(page, { dur: 1500, popup: pop.img, url: URL_NOTARA, caption: cap3 });
  await scan.page(page, { dur: 1000, popup: pop.img, cursor: { ...centre(pop.boxes.review!), on: 'popup' }, click: true, url: URL_NOTARA, caption: cap3 });
  scan.save({ frames });

  // 3. The workbench: review by structure, preview the exact request, generate.
  const review = new Recorder('review');
  const app = await x.context.newPage();
  await app.setViewportSize({ width: 1160, height: 600 });
  await app.goto(`chrome-extension://${x.extId}/sites.html#/site/${PACK}/review`);
  await expect(app.getByRole('button', { name: /翻译已选的 \d+ 条/ })).toBeVisible();
  await app.waitForTimeout(500);
  const WB = 'chrome-extension://translucid/sites.html#/review';
  await review.page(app, { dur: 1800, enter: 'fade', url: WB, caption: '在工作台按「界面 › 分区 › 问题」审核，个人内容不会出现在这里' });
  // The two "Medium" questions, scrolled clear of the sticky footer.
  const groupOf = (label: string) => app.locator('.st-group', { has: app.locator('.st-group-head', { hasText: label }) });
  await groupOf('Text size').evaluate((g) => window.scrollBy(0, g.getBoundingClientRect().top - 14));
  await app.waitForTimeout(300);
  const g1 = await boxOf(app, '.st-group:has(.st-group-head:has-text("Text size"))');
  const g2 = await boxOf(app, '.st-group:has(.st-group-head:has-text("Page width"))');
  const medium = async (label: string) => {
    const b = (await groupOf(label).locator('.st-item', { has: app.locator('.st-src', { hasText: /^Medium$/ }) }).boundingBox())!;
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  };
  const [m1, m2] = [await medium('Text size'), await medium('Page width')];
  const pair = { x: g1.x - 16, y: g1.y - 12, w: g1.w + 32, h: g2.y + g2.h - g1.y + 24 };
  const capPair = '选项连同它所属的问题一起翻译，同一个词在不同问题下可以有不同译法';
  await review.page(app, { dur: 2300, enter: 'fade', url: WB, cursor: { x: m1.x + 90, y: m1.y + m1.h / 2, on: 'page' }, zoom: pair, marks: [m1], caption: capPair });
  await review.page(app, { dur: 2300, url: WB, cursor: { x: m2.x + 90, y: m2.y + m2.h / 2, on: 'page' }, zoom: pair, marks: [m1, m2], caption: capPair });
  const go = await boxOf(app, 'button:has-text("翻译已选的")');
  await review.page(app, { dur: 900, url: WB, cursor: { ...centre(go), on: 'page' }, click: true, caption: '先看到将要发送的完整请求，再确认' });
  await app.getByRole('button', { name: /翻译已选的 \d+ 条/ }).click();
  await expect(app.getByText(/将发送 \d+ 条界面文字/)).toBeVisible();
  await app.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await app.waitForTimeout(300);
  const confirm = await boxOf(app, 'button:has-text("确认发送并生成")');
  await review.page(app, { dur: 1700, enter: 'fade', url: WB, caption: '先看到将要发送的完整请求，再确认' });
  await review.page(app, { dur: 800, url: WB, cursor: { ...centre(confirm), on: 'page' }, click: true, caption: '先看到将要发送的完整请求，再确认' });
  await fetch('http://localhost:5302/control?delay=900');
  await app.getByRole('button', { name: '确认发送并生成' }).click();
  await app.goto(`chrome-extension://${x.extId}/sites.html#/site/${PACK}/overview`);
  for (let i = 0; i < 12; i++) {
    await app.waitForTimeout(220);
    const job = (await x.msg<{ job?: { state: string } }>({ type: 'pack-job-get', id: PACK })).job;
    await review.page(app, { dur: 300, enter: 'cut', url: WB.replace('review', 'overview'), caption: '生成中，完成的条目立即在已打开的页面生效' });
    if (job?.state === 'done') break;
  }
  await fetch('http://localhost:5302/control?delay=0');
  await expect.poll(async () => (await x.msg<{ job?: { state: string } }>({ type: 'pack-job-get', id: PACK })).job?.state, { timeout: 30_000 }).toBe('done');
  await app.waitForTimeout(400);
  await review.page(app, { dur: 1200, enter: 'cut', url: WB.replace('review', 'overview'), caption: '生成中，完成的条目立即在已打开的页面生效' });

  // 4. Back on the app: the same page, now in Chinese, each "Medium" translated for its own question.
  await page.bringToFront();
  await expect(page.locator('.snav h1')).toHaveText('设置', { timeout: 15_000 });
  await page.waitForTimeout(300);
  await review.page(page, { dur: 2200, enter: 'sweep', url: URL_NOTARA, caption: '回到网站：界面已是中文，你的笔记标题保持原样' });
  // Both questions with their labels, and the two translations of "Medium" outlined.
  const sizeRow = await boxOf(page, '.row[aria-labelledby="l-size"]');
  const widthRow = await boxOf(page, '.row[aria-labelledby="l-width"]');
  const both = { x: sizeRow.x - 18, y: sizeRow.y - 18, w: sizeRow.w + 36, h: widthRow.y + widthRow.h - sizeRow.y + 30 };
  const picked = [await boxOf(page, '.row[aria-labelledby="l-size"] [aria-checked="true"]'), await boxOf(page, '.row[aria-labelledby="l-width"] [aria-checked="true"]')];
  await review.page(page, { dur: 3600, enter: 'cut', url: URL_NOTARA, zoom: both, marks: picked, caption: '文字大小里的 Medium 译作「中」，页面宽度里的译作「适中」' });
  review.save();
  await x.context.close();
});

test('picker: mark what to collect and what to leave out', async () => {
  const x = await launch();
  const page = await x.context.newPage();
  const url = await serve(page, NOTARA, notara);
  await page.goto(url);
  const tab = await tabOf(x.ext, url);
  await x.msg({ type: 'pack-collect-start', tabId: tab.id, host: HOST, targetLang: 'zh-CN' });
  const picker = page.locator('translucid-picker');
  await expect(picker.getByText('圈选界面区域')).toBeVisible();
  const rec = new Recorder('picker');
  const at = async (sel: string) => centre(await boxOf(page, sel));
  const step = async (cursor: { x: number; y: number }, opts: { dur: number; click?: boolean; keys?: string[]; caption: string }, steps = 6) => {
    await page.mouse.move(cursor.x, cursor.y, { steps });
    // The panel moves off a highlight only once the pointer rests (300 ms).
    await page.waitForTimeout(450);
    await rec.page(page, { ...opts, url: URL_NOTARA, cursor: { ...cursor, on: 'page' }, enter: 'cut' });
  };
  const caption1 = '用「调整范围」圈选要收集的区域：悬停高亮，↑ ↓ 扩大或缩小';
  await rec.page(page, { dur: 1300, enter: 'fade', url: URL_NOTARA, caption: caption1 });
  const item = await at('aside button.nav >> nth=2');
  await step(item, { dur: 1000, caption: caption1 });
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(200);
  await step(item, { dur: 1300, keys: ['↑'], click: true, caption: caption1 });
  await page.mouse.click(item.x, item.y);
  await page.waitForTimeout(250);
  await step(item, { dur: 1300, caption: '点一下就记为界面区域' });
  const exclude = picker.getByRole('button', { name: '排除内容' });
  const exBox = (await exclude.boundingBox())!;
  const exPt = { x: exBox.x + exBox.width / 2, y: exBox.y + exBox.height / 2 };
  // Straight onto the panel (the video draws the pointer's path), so the sidebar stays the highlighted region.
  await step(exPt, { dur: 800, click: true, caption: '会话、笔记这类你自己的内容，用「排除内容」标出' }, 1);
  await exclude.click();
  await step(exPt, { dur: 500, caption: '会话、笔记这类你自己的内容，用「排除内容」标出' }, 1);
  const recent = await at('.recent a >> nth=1');
  await step(recent, { dur: 900, caption: '会话、笔记这类你自己的内容，用「排除内容」标出' });
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(150);
  await step(recent, { dur: 1100, keys: ['↑'], click: true, caption: '会话、笔记这类你自己的内容，用「排除内容」标出' });
  await page.mouse.click(recent.x, recent.y);
  await page.waitForTimeout(250);
  await step(recent, { dur: 1400, caption: '会话、笔记这类你自己的内容，用「排除内容」标出' });
  // Something under the panel: resting on the part of the row still visible moves the panel away.
  await picker.getByRole('button', { name: '圈选区域' }).click();
  const theme = await boxOf(page, '.row[aria-labelledby="l-theme"]');
  const panelBox = (await picker.locator('.panel').boundingBox())!;
  await step({ x: panelBox.x - 40, y: theme.y + theme.h / 2 }, { dur: 1300, caption: '要圈的地方被面板挡住时，面板自动让开' });
  await step(await at('.more'), { dur: 1700, caption: '要圈的地方被面板挡住时，面板自动让开' });
  rec.save();
  await x.context.close();
});

test('immersive: translate an article, side by side or in place', async () => {
  const x = await launch();
  await useMediaTranslator(x.ext);
  const page = await x.context.newPage();
  const url = await serve(page, JOURNAL, journal);
  await page.goto(url);
  const tab = await tabOf(x.ext, url);
  const rec = new Recorder('immersive');
  const popup = await openPopup(x, tab, 'page');
  const pop = await rec.popup(popup, { go: '.pp-big-primary' });
  await popup.close();
  await page.bringToFront();
  const cap1 = '阅读任意网页：点「翻译此页」或按 Alt+A';
  await rec.page(page, { dur: 1300, enter: 'cut', url: URL_JOURNAL, cursor: TOOLBAR, click: true, caption: cap1 });
  await rec.page(page, { dur: 700, popup: pop.img, url: URL_JOURNAL, caption: cap1 });
  await rec.page(page, { dur: 900, popup: pop.img, cursor: { ...centre(pop.boxes.go!), on: 'popup' }, click: true, url: URL_JOURNAL, caption: cap1 });
  await fetch('http://localhost:5302/control?delay=350');
  await x.ext.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'set-enabled', enabled: true }), tab.id);
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(140);
    await rec.page(page, { dur: 220, enter: 'cut', url: URL_JOURNAL, caption: '译文逐段出现在原文下方，链接和格式保持原样' });
  }
  await fetch('http://localhost:5302/control?delay=0');
  await page.waitForTimeout(900);
  await rec.page(page, { dur: 1600, enter: 'cut', url: URL_JOURNAL, caption: '译文逐段出现在原文下方，链接和格式保持原样' });
  await x.ext.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'set-mode', mode: 'replace' }), tab.id);
  await page.waitForTimeout(500);
  await rec.page(page, { dur: 2400, enter: 'sweep', url: URL_JOURNAL, caption: '一键切换为只看译文，Alt+S 随时切回' });
  rec.save({ loop: 'sweep' });
  await x.context.close();
});
