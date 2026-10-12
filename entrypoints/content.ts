import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { Controller, type Transport } from '../src/content/controller';
import { isPackMessage } from '../src/pack/messages';
import { findSiteRule } from '../src/shared/match';
import { PORT_NAME, type RuntimeRequest, type TabCommand, type TabState, type ToBackground, type ToContent } from '../src/shared/messages';
import { loadSettings, onSettingsChanged } from '../src/shared/settings';
import { builtinExcludeList, joinSelectors } from '../src/shared/site-defaults';
import { isMostlyChinese } from '../src/shared/text';
import type { Settings, SiteRule } from '../src/shared/types';
import '../src/styles/trans.css';

/** Lazily (re)connecting port: the MV3 service worker may be killed at any time. */
class PortTransport implements Transport {
  onMessage: ((msg: ToContent) => void) | null = null;
  onDisconnect: (() => void) | null = null;
  private port: ReturnType<typeof browser.runtime.connect> | null = null;

  send(msg: ToBackground): void {
    try {
      this.ensure().postMessage(msg);
    } catch {
      // Port died between check and send: reconnect once.
      this.port = null;
      this.ensure().postMessage(msg);
    }
  }

  private ensure() {
    if (this.port) return this.port;
    const port = browser.runtime.connect({ name: PORT_NAME });
    port.onMessage.addListener((m) => this.onMessage?.(m as ToContent));
    port.onDisconnect.addListener(() => {
      // Back/forward cache or a restarted worker: handled by reconnecting on the next message.
      void browser.runtime.lastError;
      this.port = null;
      this.onDisconnect?.();
    });
    this.port = port;
    return port;
  }
}

function pageLooksChinese(): boolean {
  const lang = document.documentElement.lang.toLowerCase();
  if (lang.startsWith('zh')) return true;
  if (lang && !lang.startsWith('zh')) return false;
  return isMostlyChinese((document.body?.innerText ?? '').slice(0, 3000));
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  allFrames: false,
  async main() {
    const settings = await loadSettings();
    const rule = findSiteRule(settings.siteRules, location.hostname);
    const excludeFor = (s: Settings, r: SiteRule | undefined) =>
      joinSelectors([...builtinExcludeList(location.hostname, s.builtinSiteRules), r?.exclude]);
    const controller = new Controller(new PortTransport(), {
      mode: settings.displayMode,
      transStyle: settings.transStyle,
      fontSize: settings.transFontSize,
      lineHeight: settings.transLineHeight,
      include: rule?.include || undefined,
      exclude: excludeFor(settings, rule),
      preprocess: settings.preprocess,
    });

    onSettingsChanged((s) => {
      const r = findSiteRule(s.siteRules, location.hostname);
      controller.updateOptions({
        transStyle: s.transStyle,
        fontSize: s.transFontSize,
        lineHeight: s.transLineHeight,
        include: r?.include || undefined,
        exclude: excludeFor(s, r),
        preprocess: s.preprocess,
      });
    });

    browser.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
      // Site language pack messages belong to the pack script in this tab; answering them here would win the race.
      if (isPackMessage(raw)) return false;
      sendResponse(handleCommand(controller, raw as TabCommand));
      return false;
    });

    if (import.meta.env.MODE === 'debug') installDebugBridge(controller);

    const auto = rule?.mode === 'always' || (settings.autoTranslate && rule?.mode !== 'never' && !pageLooksChinese());
    if (auto) controller.start();
  },
});

/** One entry point for popup, keyboard commands, context menu and the debug bridge. */
export function handleCommand(controller: Controller, cmd: TabCommand): TabState {
  switch (cmd.type) {
    case 'toggle':
      controller.toggle();
      break;
    case 'set-enabled':
      if (cmd.enabled) controller.start();
      else controller.stop();
      break;
    case 'set-mode':
      if (!controller.enabled) controller.start();
      controller.setMode(cmd.mode);
      break;
    case 'toggle-mode':
      if (!controller.enabled) controller.start();
      controller.setMode(controller.mode === 'replace' ? 'bilingual' : 'replace');
      break;
    case 'set-expert':
      controller.setExpert(cmd.expertId);
      break;
    case 'refine-at-cursor':
      controller.refineAtCursor();
      break;
    case 'refine-selection':
      controller.refineSelection();
      break;
    case 'retry-failed':
      controller.retryFailed();
      break;
    case 'purge-page':
      controller.purgePage();
      break;
    case 'get-state':
      break;
  }
  return controller.state();
}

/**
 * Debug builds only (`pnpm build:debug`): lets automation drive the extension
 * from the page, since chrome.commands shortcuts and context menus cannot be
 * triggered by synthetic input. Never included in normal builds, so ordinary
 * pages cannot spend API credits.
 *
 *   window.postMessage({ xtDebug: 'start' | 'stop' | 'state' | 'metrics' | 'bilingual' | 'replace', expert?, id }, '*')
 *   → window message { xtDebugReply: id, state, metrics }
 */
function installDebugBridge(controller: Controller) {
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || typeof e.data.xtDebug !== 'string') return;
    const { xtDebug: cmd, id, expert, tab } = e.data as { xtDebug: string; id?: unknown; expert?: string; tab?: TabCommand };
    if (cmd === 'start') controller.start();
    if (cmd === 'stop') controller.stop();
    if (cmd === 'bilingual' || cmd === 'replace') controller.setMode(cmd);
    if (cmd === 'expert' && typeof expert === 'string') controller.setExpert(expert);
    if (cmd === 'clear-metrics') controller.metrics = [];
    if (cmd === 'wave') controller.debugEnqueueWave(Number((e.data as { n?: number }).n) || 10);
    if (cmd === 'reload-ext') void browser.runtime.sendMessage({ type: 'reload-ext' } satisfies RuntimeRequest);
    if (cmd === 'skeleton') {
      // Structure only (see src/pack/skeleton.ts); saved by the operator to the gitignored research/ folder.
      void import('../src/pack/skeleton').then(({ skeleton }) => window.postMessage({ xtDebugReply: id ?? null, skeleton: skeleton(document.body) }, '*'));
      return;
    }
    if (cmd === 'pack') {
      const { op, needles, on } = e.data as { op: 'state' | 'contains' | 'toggle' | 'scan' | 'scan-summary'; needles?: string[]; on?: boolean };
      void browser.runtime.sendMessage({ type: 'pack-debug', op, needles, on })
        .then((pack) => window.postMessage({ xtDebugReply: id ?? null, pack }, '*'));
      return;
    }
    if (cmd === 'provider') {
      const { active, short, fallback } = e.data as { active?: string; short?: string; fallback?: string };
      void browser.runtime.sendMessage({ type: 'debug-provider', active, short, fallback } satisfies RuntimeRequest)
        .then((providers) => window.postMessage({ xtDebugReply: id ?? null, providers }, '*'));
      return;
    }
    // Exercise the exact popup protocol: { xtDebug: 'tab', tab: { type: 'retry-failed' } }
    const state = cmd === 'tab' && tab ? handleCommand(controller, tab) : controller.state();
    window.postMessage({ xtDebugReply: id ?? null, state, metrics: controller.metrics }, '*');
  });
  document.documentElement.setAttribute('data-xt-debug', '1');
}
