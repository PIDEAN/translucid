// One-click scan. Injected on demand (never registered), it explores the
// current page's navigation and popups with the Explorer, collects interface
// strings at each step (content is only counted), and reports back. Every
// message carries the scan id and nonce the background issued for this tab.
import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { joinSelectors } from '../src/pack/dom-rules';
import { variantKey } from '../src/pack/format';
import { Explorer, hasDraft, type ExploreReport } from '../src/pack/explorer';
import { collect, type StructuredCandidate } from '../src/pack/harvest';
import type { PackRequest, ScanRun } from '../src/pack/messages';
import { packRegistry } from '../src/pack/registry';
import { ScanOverlay } from '../src/pack/scan-overlay';

const RUNNING = Symbol.for('translucid.scan.runtime');
const FLUSH_MS = 2000;
const PROGRESS_MS = 1000;

export default defineContentScript({
  matches: ['<all_urls>'],
  registration: 'runtime',
  allFrames: false,
  main(ctx) {
    const g = globalThis as unknown as Record<symbol, boolean>;
    if (g[RUNNING]) return;
    g[RUNNING] = true;
    let active: ScanRun | undefined;
    let stopRequested = false;

    const send = (msg: PackRequest) => browser.runtime.sendMessage(msg).catch(() => undefined);

    async function run(cmd: ScanRun): Promise<void> {
      active = cmd;
      stopRequested = false;
      const auth = { scanId: cmd.scanId, nonce: cmd.nonce };
      if (hasDraft(document)) {
        await send({ type: 'pack-scan-done', ...auth, refused: 'draft' });
        active = undefined;
        return;
      }
      const sent = new Set<string>();
      const contentSeen = new Set<string>();
      let buffer: StructuredCandidate[] = [];
      let content = 0;
      let lastProgress = 0;
      const flush = async () => {
        if (!buffer.length) return;
        const candidates = buffer;
        buffer = [];
        await send({ type: 'pack-scan-candidates', ...auth, candidates });
      };
      const timer = setInterval(() => void flush(), FLUSH_MS);
      const overlay = new ScanOverlay(document, () => (stopRequested = true));
      const reg = packRegistry();
      reg.scanning = true;
      overlay.open();
      let report: ExploreReport | undefined;
      try {
        const explorer = new Explorer(document, {
          collect: (root) => {
            const res = collect(document, {
              scope: 'auto',
              roots: [root],
              regions: cmd.regions,
              exclude: joinSelectors(cmd.excludes),
              targetLang: cmd.targetLang,
              includeOwned: true,
              contentSeen,
            });
            content += res.content;
            for (const c of res.candidates) {
              const k = variantKey(c.kind, c.src, c.ctx);
              if (sent.has(k)) continue;
              sent.add(k);
              buffer.push({ ...c, source: 'scan' });
            }
          },
          progress: (p) => {
            overlay.update(p.step, p.actions, p.visited, sent.size);
            const now = Date.now();
            if (now - lastProgress > PROGRESS_MS) {
              lastProgress = now;
              void send({ type: 'pack-scan-progress', ...auth, actions: p.actions, visited: p.visited, strings: sent.size });
            }
          },
          shouldStop: () => stopRequested || ctx.isInvalid,
        });
        report = await explorer.run();
      } finally {
        clearInterval(timer);
        overlay.close();
        reg.scanning = false;
        await flush();
        await send({
          type: 'pack-scan-done',
          ...auth,
          report: report && { ...report, strings: sent.size, content },
          ...(report?.refused ? { refused: report.refused } : report ? {} : { refused: 'error' as const }),
        });
        active = undefined;
      }
    }

    const onMessage = (raw: unknown, _sender: unknown, sendResponse: (r: unknown) => void) => {
      const m = raw as { type?: string } & Partial<ScanRun>;
      if (m?.type === 'pack-scan-run') {
        if (active) sendResponse({ ok: false, error: '扫描已在进行' });
        else {
          void run(m as ScanRun);
          sendResponse({ ok: true });
        }
        return false;
      }
      if (m?.type === 'pack-scan-ping') {
        sendResponse({ alive: !!active && m.scanId === active.scanId });
        return false;
      }
      if (m?.type === 'pack-scan-stop') {
        if (active && m.scanId === active.scanId) stopRequested = true;
        sendResponse({ ok: true });
        return false;
      }
      return false;
    };
    browser.runtime.onMessage.addListener(onMessage);
    ctx.onInvalidated(() => {
      stopRequested = true;
      browser.runtime.onMessage.removeListener(onMessage);
      g[RUNNING] = false;
    });
  },
});
