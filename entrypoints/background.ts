import { browser } from 'wxt/browser';
import { applyPackPatch } from '../src/pack/patch';
import { defineBackground } from 'wxt/utils/define-background';
import { cacheClear, cacheCount } from '../src/background/cache';
import { machineTranslate } from '../src/background/mt';
import { completeChat, detectDeepSeekRegion, loadOpenRouterFreeModels } from '../src/background/providers';
import { TranslateSession } from '../src/background/session';
import { loadUsage } from '../src/background/usage';
import { deletePack, getPack, listPacks, mutatePack, reconcilePacks, savePack, setPackEnabled } from '../src/background/pack-store';
import {
  clearRecord,
  clearReport,
  createRecord,
  getRecord,
  grantConsent,
  hasConsent,
  recordForSender,
  sanitizeReport,
  saveReport,
  SCAN_SCRIPT_FILE,
  STALE_SCAN_MS,
  scanStatus,
  updateRecord,
} from '../src/background/pack-scan';
import { isPackMessage, type PackRequest, type PackResponse, type PackTabCommand } from '../src/pack/messages';
import { addCandidates, clearIgnored, clearPending, dropPending, getPending, ignorePending, pendingKey, sanitizeCandidates, tierOf } from '../src/background/pack-pending';
import { PACK_SCRIPT_FILE } from '../src/background/pack-registry';
import { emptyPack, ENTRY_KINDS, entryKey, isValidHost, isValidLang, markStale, normalizeKey, packId, variantKey, type EntryKind } from '../src/pack/format';
import { batchMessages, cancelJob, createDescribePlan, createPlan, getJob, packProvider, pauseInterruptedJobs, resumeJob, runDescribePlan, startJob } from '../src/background/pack-gen';
import { formatCost } from '../src/shared/cost';
import { PORT_NAME, type PageIntentRequest, type RuntimeRequest, type TabCommand, type ToBackground } from '../src/shared/messages';
import { sendToTab } from '../src/shared/tab-state';
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, saveSettings } from '../src/shared/settings';
import { costOf, isMachineTranslation, resolvedPrice, vendorOf } from '../src/shared/pricing';
import type { ProviderConfig, Settings } from '../src/shared/types';

export default defineBackground(() => {
  let settings: Settings = DEFAULT_SETTINGS;
  const ready = loadSettings().then((s) => (settings = s));
  void ready.then(() => autoDetectRegions());

  /** Fill in detectedRegion for DeepSeek providers left on "auto", once per key. */
  async function autoDetectRegions() {
    const todo = settings.providers.filter((p) => vendorOf(p) === 'deepseek' && p.apiKey && (p.region ?? 'auto') === 'auto' && !p.detectedRegion);
    if (!todo.length) return;
    const found = await Promise.all(todo.map((p) => detectDeepSeekRegion(p)));
    if (!found.some(Boolean)) return;
    const fresh = await loadSettings();
    fresh.providers = fresh.providers.map((p) => {
      const i = todo.findIndex((t) => t.id === p.id && t.apiKey === p.apiKey);
      return i >= 0 && found[i] ? { ...p, detectedRegion: found[i] } : p;
    });
    await saveSettings(fresh);
  }
  onSettingsChanged((s) => (settings = s));

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;
    const session = new TranslateSession(port, () => settings);
    port.onMessage.addListener((msg) => {
      void ready.then(() => session.handle(msg as ToBackground)).catch((e) => console.error('[xt]', e));
    });
    port.onDisconnect.addListener(() => {
      // A page put into the back/forward cache closes its port with an error; reading it marks
      // it handled (otherwise Chrome logs "Unchecked runtime.lastError" on the extension).
      void browser.runtime.lastError;
      session.dispose();
    });
  });

  browser.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    if (isPackMessage(raw)) {
      void handlePackRequest(raw as PackRequest, sender).then(sendResponse, (e) =>
        sendResponse({ ok: false, error: String(e?.message ?? e) } satisfies PackResponse),
      );
      return true;
    }
    const req = raw as RuntimeRequest;
    const reply = (p: Promise<unknown>) => {
      p.then(sendResponse, (e) => sendResponse({ error: String(e?.message ?? e) }));
      return true;
    };
    switch (req.type) {
      case 'test-provider':
        return reply(testProvider(req.provider));
      case 'openrouter-free-models':
        return reply(loadOpenRouterFreeModels().then((models) => ({ models })));
      case 'cache-clear':
        return reply(cacheClear().then(() => ({ ok: true })));
      case 'cache-count':
        return reply(cacheCount().then((count) => ({ count })));
      case 'usage':
        return reply(loadUsage());
      case 'reload-ext':
        if (import.meta.env.MODE !== 'debug') return false;
        setTimeout(() => browser.runtime.reload(), 100);
        return reply(Promise.resolve({ ok: true }));
      case 'debug-provider':
        if (import.meta.env.MODE !== 'debug') return false;
        return reply(debugProvider(req.active, req.short, req.fallback));
      case 'frame-join': {
        // Only a subframe joins; the answer comes from the top document of the same tab.
        const tabId = sender.tab?.id;
        if (tabId === undefined || !sender.frameId) return reply(Promise.resolve(null));
        return reply(browser.tabs.sendMessage(tabId, { type: 'page-intent' } satisfies PageIntentRequest, { frameId: 0 }).catch(() => null));
      }
    }
    return false;
  });

  // Every translating document of the tab gets the command, toggles resolved for the whole tab.
  const sendToActiveTab = async (cmd: TabCommand) => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined) await sendToTab(tab.id, cmd).catch(() => {});
  };

  browser.commands.onCommand.addListener((command) => {
    if (command === 'toggle-translate') void sendToActiveTab({ type: 'toggle' });
    if (command === 'toggle-mode') void sendToActiveTab({ type: 'toggle-mode' });
    // Started from the keyboard, the page keeps focus: a menu it has open stays open for picking.
    if (command === 'pick-regions') {
      void (async () => {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        let host = '';
        try {
          host = new URL(tab?.url ?? '').hostname.toLowerCase();
        } catch {
          return;
        }
        if (tab?.id === undefined || !/^https?:/.test(tab.url ?? '')) return;
        const s = await loadSettings();
        await startPicker(tab.id, host, s.packTargetLang || 'zh-CN').catch(() => undefined);
      })();
    }
  });

  // Dynamic content script registrations must match the stored packs after install, update or restart.
  void reconcilePacks();
  // Nothing survives a service-worker restart: generation jobs that were running wait for the user.
  void pauseInterruptedJobs();
  browser.runtime.onStartup.addListener(() => void reconcilePacks());
  // A scan ends with its tab. (A new document in the tab has a new documentId, so a
  // left-over record no longer authorizes anything; routes and hashes keep the document.)
  browser.tabs.onRemoved.addListener((tabId) => void clearRecord(tabId));

  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.removeAll(() => {
      browser.contextMenus.create({ id: 'xt-toggle', title: '翻译 / 恢复此页 (Alt+A)', contexts: ['page', 'selection', 'link'] });
      browser.contextMenus.create({ id: 'xt-refine', title: '精翻此段', contexts: ['page', 'selection', 'link'] });
    });
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (tab?.id === undefined) return;
    // 精翻此段 refines the paragraph under the menu, in the document where it was opened.
    if (info.menuItemId === 'xt-refine') void browser.tabs.sendMessage(tab.id, { type: 'refine-at-cursor' } satisfies TabCommand, { frameId: info.frameId ?? 0 }).catch(() => {});
    else void sendToTab(tab.id, { type: 'toggle' }).catch(() => {});
  });
});

/** Never returns keys: only whether each provider has one. */
async function debugProvider(active?: string, short?: string, fallback?: string) {
  const s = await loadSettings();
  if (active !== undefined || short !== undefined || fallback !== undefined) {
    if (active !== undefined) s.activeProviderId = active;
    if (short !== undefined) s.shortTextProviderId = short;
    if (fallback !== undefined) s.fallbackProviderId = fallback;
    await saveSettings(s);
  }
  return {
    active: s.activeProviderId,
    short: s.shortTextProviderId,
    fallback: s.fallbackProviderId,
    refine: s.refineProviderId,
    providers: s.providers.map((p) => ({ id: p.id, model: p.model, concurrency: p.concurrency, hasKey: !!p.apiKey })),
  };
}

/** Rough cost of a planned job: prompt ≈ request chars / 3, completion ≈ source strings again. */
function estimatePlan(p: ProviderConfig, messages: { content: string }[][], sourceChars: number): string {
  const promptChars = messages.flat().reduce((n, m) => n + m.content.length, 0);
  const usage = { promptTokens: Math.ceil(promptChars / 3), cacheHitTokens: 0, completionTokens: Math.ceil((sourceChars * 1.3) / 3) };
  const spec = resolvedPrice(p);
  const cost = costOf(usage, spec);
  return `约 ${usage.promptTokens + usage.completionTokens} tokens，${spec.subscription ? '订阅额度内' : formatCost(cost, spec.currency)}`;
}

/** Pages of this extension (options, popup); web pages and content scripts may not change packs. */
function fromExtensionPage(sender: { url?: string; tab?: unknown }): boolean {
  return !!sender.url?.startsWith(browser.runtime.getURL('/'));
}

/** Debug-build test hook for real sites (see PackRequest 'pack-debug'). */
async function packDebug(
  req: Extract<PackRequest, { type: 'pack-debug' }>,
  sender: { tab?: { id?: number; url?: string } },
): Promise<PackResponse> {
  if (import.meta.env.MODE !== 'debug') return { ok: false, error: 'debug builds only' };
  let host = '';
  try {
    host = new URL(sender.tab?.url ?? '').hostname.toLowerCase();
  } catch {
    /* ignore */
  }
  const s = await loadSettings();
  if (!host || !(s.debugHosts ?? []).includes(host)) return { ok: false, error: 'host not in debugHosts' };
  const items = (await listPacks()).filter((p) => p.hosts.includes(host));
  if (req.op === 'scan' && sender.tab?.id !== undefined) {
    const pack = items[0];
    const r = await startScan(sender.tab.id, host, pack?.targetLang ?? s.packTargetLang ?? 'zh-CN', true);
    return r.ok ? { ok: true, job: { started: true } } : r;
  }
  if (req.op === 'scan-summary') {
    const st = await scanStatus(sender.tab?.id, items[0]?.id);
    const rep = st.last?.report;
    // Counts and outcomes only.
    return {
      ok: true,
      job: {
        running: st.running,
        progress: st.progress,
        refused: st.last?.refused,
        report: rep && {
          visited: rep.visited.length,
          skipped: rep.skipped.length,
          actions: rep.actions,
          ms: rep.ms,
          budgetHit: rep.budgetHit,
          stopped: rep.stopped,
          guard: !!rep.guard,
          restore: rep.restore,
          unrestored: rep.unrestored.length,
          strings: rep.strings,
          content: rep.content,
        },
      },
    };
  }
  if (req.op === 'toggle' && sender.tab?.id !== undefined) {
    await browser.tabs.sendMessage(sender.tab.id, { type: 'pack-toggle', on: req.on } satisfies PackTabCommand).catch(() => undefined);
  }
  const details = await Promise.all(
    items.map(async (p) => {
      const [pack, pending, job] = await Promise.all([getPack(p.id), getPending(p.id), getJob(p.id)]);
      const pend = new Set(pending.map((x) => x.src));
      const ent = new Set(pack?.entries.map((e) => e.src) ?? []);
      return {
        id: p.id,
        enabled: p.enabled,
        entries: ent.size,
        pending: pending.length,
        flagged: pending.filter((x) => x.flags.length).length,
        regions: pack?.regions.length ?? 0,
        job: job ? { state: job.state, done: Object.keys(job.results).length, total: job.snapshot.items.length } : null,
        // Membership only, for strings the page already shows (e.g. "is this chat title collected?").
        contains: req.op === 'contains' ? (req.needles ?? []).slice(0, 200).map((n) => ({ inPending: pend.has(n), inEntries: ent.has(n) })) : undefined,
      };
    }),
  );
  return { ok: true, job: details };
}

/**
 * Start a one-click scan of a tab: consent (remembered per site), the pack
 * (created if needed, switched to automatic scope), a scan id + nonce bound to
 * the tab, document and host, then the scan script.
 */
async function startScan(tabId: number, host: string, targetLang: string, consent: boolean): Promise<PackResponse> {
  if (!isValidHost(host) || !isValidLang(targetLang)) return { ok: false, error: '此页面不支持站点本地化' };
  const tab = await browser.tabs.get(tabId).catch(() => undefined);
  let tabHost = '';
  try {
    tabHost = new URL(tab?.url ?? '').hostname.toLowerCase();
  } catch {
    /* no url */
  }
  if (tabHost !== host) return { ok: false, error: '标签页已切换到其他网站' };
  if (!(await hasConsent(host))) {
    if (!consent) return { ok: false, error: 'need-consent' };
    await grantConsent(host);
  }
  // Injecting twice is harmless (the script keeps one instance per document) and tells us the document.
  const [res] = await browser.scripting.executeScript({ target: { tabId }, files: [SCAN_SCRIPT_FILE] });
  const documentId = (res as { documentId?: string } | undefined)?.documentId;
  const running = await getRecord(tabId);
  if (running && running.documentId === documentId && Date.now() - running.startedAt < STALE_SCAN_MS) return { ok: false, error: '扫描已在进行' };
  const id = packId(host, targetLang);
  const pack = (await getPack(id)) ?? (await savePack(emptyPack(host, targetLang))).pack;
  // One-click localization is automatic scope by definition (the user just asked for it).
  if (pack.options.scope !== 'auto') await mutatePack(id, (p) => ({ ...p, options: { ...p.options, scope: 'auto' } }));
  const rec = await createRecord(tabId, host, id);
  try {
    if (documentId) await updateRecord({ ...rec, documentId });
    const r = (await browser.tabs.sendMessage(tabId, {
      type: 'pack-scan-run',
      scanId: rec.scanId,
      nonce: rec.nonce,
      packId: id,
      targetLang: pack.targetLang,
      regions: pack.regions,
      excludes: pack.excludes,
    } satisfies PackTabCommand)) as { ok?: boolean; error?: string } | undefined;
    if (!r?.ok) throw new Error(r?.error ?? '扫描脚本没有响应');
  } catch (e) {
    await clearRecord(tabId);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, scan: await scanStatus(tabId, id) };
}

/** Open the region picker in a tab (popup button or the pick-regions shortcut). */
async function startPicker(tabId: number, host: string, targetLang: string): Promise<PackResponse> {
  if (!isValidHost(host) || !isValidLang(targetLang)) return { ok: false, error: '此页面不支持语言包' };
  const id = packId(host, targetLang);
  const pack = (await getPack(id)) ?? (await savePack(emptyPack(host, targetLang))).pack;
  await browser.scripting.executeScript({ target: { tabId }, files: [PACK_SCRIPT_FILE] });
  // The panel names the shortcut as the user has it now (they can change it in the browser).
  const commands = await browser.commands.getAll().catch(() => []);
  await browser.tabs.sendMessage(tabId, {
    type: 'pack-pick-start',
    packId: id,
    targetLang: pack.targetLang,
    regions: pack.regions,
    excludes: pack.excludes,
    shortcut: commands.find((c) => c.name === 'pick-regions')?.shortcut ?? '',
  } satisfies PackTabCommand);
  return { ok: true, pack };
}

/** Content-script requests may only touch packs of the host their tab shows. */
async function packForSenderTab(id: string, sender: { tab?: { url?: string } }) {
  const pack = await getPack(id);
  let host = '';
  try {
    host = new URL(sender.tab?.url ?? '').hostname.toLowerCase();
  } catch {
    /* no tab url */
  }
  return pack && host && pack.site.hosts.includes(host) ? pack : undefined;
}

async function handlePackRequest(req: PackRequest, sender: { url?: string; tab?: { url?: string } }): Promise<PackResponse> {
  switch (req.type) {
    case 'pack-list':
      return { ok: true, index: await listPacks() };
    case 'pack-get':
      return { ok: true, pack: await getPack(req.id) };
    case 'pack-regions-save': {
      const pack = await packForSenderTab(req.id, sender);
      if (!pack) return { ok: false, error: 'pack not found for this page' };
      const { pack: saved } = await savePack({ ...pack, regions: req.regions, excludes: req.excludes });
      return { ok: true, pack: saved };
    }
    case 'pack-candidates-add': {
      const pack = await packForSenderTab(req.id, sender);
      if (!pack) return { ok: false, error: 'pack not found for this page' };
      return { ok: true, added: await addCandidates(pack, sanitizeCandidates(pack, req.candidates)) };
    }
    case 'pack-pending-drop': {
      const pack = await packForSenderTab(req.id, sender);
      if (!pack || !Array.isArray(req.strings)) return { ok: false, error: 'pack not found for this page' };
      const keys = req.strings
        .filter((x) => typeof x?.src === 'string' && ENTRY_KINDS.includes(x.kind))
        .slice(0, 5000)
        .map((x) => entryKey(x.kind, x.src));
      await dropPending(pack.id, keys);
      return { ok: true };
    }
    case 'pack-debug':
      return packDebug(req, sender as { tab?: { id?: number; url?: string } });
    case 'pack-scan-candidates': {
      const rec = await recordForSender(req, sender);
      const pack = rec && (await getPack(rec.packId));
      if (!pack) return { ok: false, error: 'no active scan' };
      return { ok: true, added: await addCandidates(pack, sanitizeCandidates(pack, req.candidates)) };
    }
    case 'pack-scan-progress': {
      const rec = await recordForSender(req, sender);
      if (!rec) return { ok: false, error: 'no active scan' };
      const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
      await updateRecord({ ...rec, progress: { actions: n(req.actions), visited: n(req.visited), strings: n(req.strings) } });
      return { ok: true };
    }
    case 'pack-scan-done': {
      const rec = await recordForSender(req, sender);
      if (!rec) return { ok: false, error: 'no active scan' };
      await saveReport(rec.packId, sanitizeReport(req.report), req.refused === 'draft' || req.refused === 'error' ? req.refused : undefined);
      await clearRecord(rec.tabId);
      return { ok: true };
    }
  }
  if (!fromExtensionPage(sender)) return { ok: false, error: '只能在扩展页面中修改语言包' };
  const settings = await loadSettings();
  switch (req.type) {
    case 'pack-save': {
      const { pack, warnings } = await savePack(req.pack, { enabled: req.enabled, expectRev: req.expectRev });
      return { ok: true, pack, warnings, index: await listPacks() };
    }
    case 'pack-update': {
      const pack = await mutatePack(req.id, (p) => applyPackPatch(p, req.patch ?? {}));
      return pack ? { ok: true, pack, index: await listPacks() } : { ok: false, error: '语言包不存在' };
    }
    case 'pack-entry-edit': {
      const key = variantKey(req.kind as EntryKind, normalizeKey(String(req.src)), req.ctx);
      const pack = await mutatePack(req.id, (p) => {
        const i = p.entries.findIndex((e) => variantKey(e.kind, e.src, e.ctx) === key);
        if (i < 0) return undefined;
        if (req.remove) p.entries.splice(i, 1);
        else if (typeof req.t === 'string' && req.t.trim()) p.entries[i] = { ...p.entries[i]!, t: req.t.trim(), status: 'edited' };
        else return undefined;
        return p;
      });
      return pack ? { ok: true, pack } : { ok: false, error: '语言包不存在' };
    }
    case 'pack-entries-stale': {
      const pack = await mutatePack(req.id, (p) => (req.op === 'mark' ? markStale(p) : { ...p, entries: p.entries.filter((e) => e.status !== 'stale') }));
      return pack ? { ok: true, pack } : { ok: false, error: '语言包不存在' };
    }
    case 'pack-delete':
      await deletePack(req.id);
      await Promise.all([clearPending(req.id), clearIgnored(req.id), clearReport(req.id)]);
      return { ok: true, index: await listPacks() };
    case 'pack-set-enabled':
      await setPackEnabled(req.id, req.enabled);
      return { ok: true, index: await listPacks() };
    case 'pack-collect-start':
      return startPicker(req.tabId, req.host, req.targetLang);
    case 'pack-plan': {
      const plan = await createPlan({ packId: req.id, keys: req.keys, description: req.description }, settings);
      const provider = packProvider(settings, plan.providerId)!;
      const fb = plan.fallbackId ? packProvider(settings, plan.fallbackId) : undefined;
      const messages = plan.batches.map((b) => batchMessages(plan.snapshot, b));
      const sourceChars = plan.snapshot.items.reduce((n, it) => n + it.src.length, 0);
      const dest = (p: ProviderConfig) => ({ name: p.name, baseURL: p.baseURL, model: p.model });
      return {
        ok: true,
        plan: { planId: plan.planId, messages, items: plan.snapshot.items.length, destination: dest(provider), fallback: fb && dest(fb), estimate: estimatePlan(provider, messages, sourceChars) },
      };
    }
    case 'pack-generate':
      if (typeof req.planId !== 'string') return { ok: false, error: '请先预览将要发送的内容' };
      return { ok: true, job: await startJob(req.id, req.planId, settings) };
    case 'pack-job-get':
      return { ok: true, job: await getJob(req.id) };
    case 'pack-job-cancel':
      await cancelJob(req.id);
      return { ok: true, job: await getJob(req.id) };
    case 'pack-job-resume':
      await resumeJob(req.id, settings);
      return { ok: true, job: await getJob(req.id) };
    case 'pack-describe-plan': {
      const { plan, provider, items } = await createDescribePlan(req.id, req.keys, settings);
      const dest = { name: provider.name, baseURL: provider.baseURL, model: provider.model };
      return { ok: true, plan: { planId: plan.planId, messages: [plan.messages], items, destination: dest, estimate: estimatePlan(provider, [plan.messages], 400) } };
    }
    case 'pack-describe':
      if (typeof req.planId !== 'string') return { ok: false, error: '请先预览将要发送的内容' };
      return { ok: true, text: await runDescribePlan(req.id, req.planId, settings) };
    case 'pack-scan-start':
      return startScan(req.tabId, req.host, req.targetLang, req.consent === true);
    case 'pack-scan-cancel': {
      const rec = await getRecord(req.tabId);
      if (rec) {
        // Unreachable script (reloaded tab): the record goes, so the UI is never stuck on "scanning".
        const sent = await browser.tabs.sendMessage(req.tabId, { type: 'pack-scan-stop', scanId: rec.scanId } satisfies PackTabCommand).then(() => true, () => false);
        if (!sent) await clearRecord(req.tabId);
      }
      return { ok: true, scan: await scanStatus(req.tabId, rec?.packId) };
    }
    case 'pack-scan-status':
      return { ok: true, scan: await scanStatus(req.tabId, req.packId) };
    case 'pack-pending-get':
      return {
        ok: true,
        pending: (await getPending(req.id)).map((p) => {
          const { firstSeen: _f, ...view } = p;
          return { ...view, key: pendingKey(p), tier: tierOf(p) };
        }),
      };
    case 'pack-pending-clear':
      await clearPending(req.id, req.keys);
      if (!req.keys) await clearIgnored(req.id);
      return { ok: true };
    case 'pack-pending-ignore':
      if (!Array.isArray(req.keys)) return { ok: false, error: 'bad keys' };
      await ignorePending(req.id, req.keys.filter((k) => typeof k === 'string').slice(0, 5000));
      return { ok: true };
    case 'pack-scan-clear':
      await clearReport(req.id);
      return { ok: true };
  }
  return { ok: false, error: 'unknown pack request' };
}

async function testProvider(p: ProviderConfig) {
  const t0 = performance.now();
  if (isMachineTranslation(p)) {
    const [text] = await machineTranslate(p, ['Ship small, reversible changes.']);
    return { text, ms: Math.round(performance.now() - t0) };
  }
  const [res, region] = await Promise.all([
    completeChat(p, [
      { role: 'system', content: 'Translate the user text into Simplified Chinese. Output only the translation.' },
      { role: 'user', content: 'Ship small, reversible changes.' },
    ]),
    vendorOf(p) === 'deepseek' ? detectDeepSeekRegion(p) : Promise.resolve(undefined),
  ]);
  return { text: res.text, ms: Math.round(performance.now() - t0), usage: res.usage, region };
}
