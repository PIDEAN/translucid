import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { Controller, type Transport } from '../src/content/controller';
import { pageFrameReady, sensitiveFrame, siteHost } from '../src/content/frames';
import { applyIntent, emptyIntent, IntentFollower, noteIntent } from '../src/content/page-intent';
import { isPackMessage } from '../src/pack/messages';
import { FRAME_INTENT_SETTER, FRAME_STATE_GETTER, PAGE_COMMANDS, type FrameReport } from '../src/shared/frame-state';
import { findSiteRule } from '../src/shared/match';
import { PORT_NAME, type PageIntent, type PageIntentRequest, type RuntimeRequest, type TabCommand, type TabState, type ToBackground, type ToContent, type TopReply } from '../src/shared/messages';
import { loadSettings, onSettingsChanged } from '../src/shared/settings';
import { builtinExcludeList, joinSelectors } from '../src/shared/site-defaults';
import { isMostlyChinese } from '../src/shared/text';
import type { Settings, SiteRule } from '../src/shared/types';
import '../src/styles/trans.css';

/**
 * Lazily (re)connecting port: the MV3 service worker may be killed at any time. While `blocked` says so,
 * nothing but a reset leaves this document, whichever path tries to send.
 */
class PortTransport implements Transport {
  onMessage: ((msg: ToContent) => void) | null = null;
  onDisconnect: (() => void) | null = null;
  private port: ReturnType<typeof browser.runtime.connect> | null = null;

  constructor(private blocked: () => boolean = () => false) {}

  send(msg: ToBackground): void {
    if (msg.type !== 'reset' && this.blocked()) return;
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
  // Subframes only take part when they are the page itself (see src/content/frames.ts).
  allFrames: true,
  async main() {
    const top = window === window.top;
    if (!top && !(await pageFrameReady())) return;
    // The top document is the one source of the user's choices for the page; frames follow its intent
    // (src/content/page-intent.ts).
    const intent = emptyIntent();
    let controller: Controller | null = null;
    // "Always translate this site" (read with the settings): on while the page holds no on/off choice.
    let always = false;
    const follower = top
      ? null
      : new IntentFollower((i) => {
          if (!controller) return;
          applyIntent(controller, i);
          if (i.enabled === null && always) controller.start();
        });
    // Whoever sends a page command writes the new intent into the frames (src/shared/tab-state.ts).
    // A frame that has not heard from its page yet asks again when an update comes (it never guesses the page).
    const ask = () => browser.runtime.sendMessage({ type: 'frame-join' } satisfies RuntimeRequest).catch(() => null) as Promise<PageIntent | null>;
    let asking: Promise<void> | null = null;
    const catchUp = () => {
      asking ??= ask().then((i) => {
        asking = null;
        follower?.join(i);
      });
      return asking;
    };
    if (follower) {
      (globalThis as unknown as Record<string, unknown>)[FRAME_INTENT_SETTER] = (i: unknown) => {
        follower.offer(i);
        if (!follower.bound && handle) void catchUp();
      };
    }
    // Listening from the start: commands that reach the top document before it is set up are answered
    // once it is, in order.
    let handle: ((cmd: TabCommand) => TabState) | null = null;
    let failed = false;
    const early: { cmd: TabCommand; reply: (r: TopReply | null) => void }[] = [];
    const replyOf = (state: TabState): TopReply => ({ ...state, intent: { ...intent } });
    browser.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
      // Site language pack messages belong to the pack script in this tab; answering them here would win the race.
      if (isPackMessage(raw)) return false;
      const msg = raw as TabCommand | PageIntentRequest;
      if (msg.type === 'page-intent') {
        if (top) sendResponse(intent);
        return false;
      }
      // Page commands are the top document's; a frame takes them over through the intent.
      if (!top && PAGE_COMMANDS.has(msg.type)) return false;
      if (!handle) {
        if (!top || failed) return false;
        early.push({ cmd: msg, reply: sendResponse });
        return true;
      }
      // Only the top document answers, so the reply is always its own.
      const state = handle(msg);
      if (top) sendResponse(replyOf(state));
      return false;
    });

    try {
      const settings = await loadSettings();
      // Always / never follow the site the user is on; selectors are written for this document's own site.
      const host = siteHost(location);
      const modeRule = (s: Settings) => findSiteRule(s.siteRules, host);
      const selectorRule = (s: Settings) => (host === location.hostname ? modeRule(s) : findSiteRule(s.siteRules, location.hostname));
      const excludeFor = (s: Settings, r: SiteRule | undefined) =>
        joinSelectors([...builtinExcludeList(location.hostname, s.builtinSiteRules), r?.exclude]);
      const rule = modeRule(settings);
      const sel = selectorRule(settings);
      // A frame holding recognizable sign-in or payment fields is not translated: it cannot start, and nothing
      // leaves it (restarts, refinement, retries and preprocessing all go through the transport).
      const blocked = () => !top && sensitiveFrame(document);
      const ctl = new Controller(new PortTransport(blocked), {
        mode: settings.displayMode,
        transStyle: settings.transStyle,
        fontSize: settings.transFontSize,
        lineHeight: settings.transLineHeight,
        include: sel?.include || undefined,
        exclude: excludeFor(settings, sel),
        preprocess: settings.preprocess,
        canStart: () => !blocked(),
      });
      controller = ctl;

      onSettingsChanged((s) => {
        const r = selectorRule(s);
        ctl.updateOptions({
          transStyle: s.transStyle,
          fontSize: s.transFontSize,
          lineHeight: s.transLineHeight,
          include: r?.include || undefined,
          exclude: excludeFor(s, r),
          preprocess: s.preprocess,
        });
      });
      if (!top) stopOnSensitiveFields(ctl, blocked);

      // The popup and the keyboard commands read every translating document of the tab (src/shared/tab-state.ts);
      // a frame that may not be translated stays out of it.
      (globalThis as unknown as Record<string, unknown>)[FRAME_STATE_GETTER] = (): FrameReport | null => {
        if (top) return { state: ctl.state(), intent: { ...intent } };
        return ctl.enabled || !blocked() ? { state: ctl.state(), follows: follower!.status() } : null;
      };

      handle = (cmd) => {
        const state = handleCommand(ctl, cmd);
        if (top && PAGE_COMMANDS.has(cmd.type)) noteIntent(intent, cmd, ctl);
        return state;
      };

      if (import.meta.env.MODE === 'debug' && top) installDebugBridge(ctl);

      if (top) {
        const auto = rule?.mode === 'always' || (settings.autoTranslate && rule?.mode !== 'never' && !pageLooksChinese());
        if (auto) ctl.start();
        for (const { cmd, reply } of early.splice(0)) reply(replyOf(handle(cmd)));
        return;
      }
      // A frame joining the page takes over what the user chose there so far; with no choice yet, only
      // "always translate this site" starts it (global auto-translate covers top documents, not their frames).
      // That rule is applied with the page's answer, so an older answer arriving late cannot undo a newer one.
      always = rule?.mode === 'always';
      await catchUp();
      // No answer from the page at all: the site rule alone decides.
      if (!follower!.bound && always) ctl.start();
      // An update that did not arrive is caught up when the user turns to the frame.
      window.addEventListener('focus', () => void catchUp());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void catchUp();
      });
    } catch (e) {
      // Set-up failed (settings unreadable): answer what waits, and let later requests fail at once.
      failed = true;
      for (const { reply } of early.splice(0)) reply(null);
      console.warn('[xt] page translation unavailable here', e);
    }
  },
});

/** Sign-in or payment fields appearing in a translating frame (a single-page app) stop it at once. */
function stopOnSensitiveFields(controller: Controller, blocked: () => boolean): void {
  let queued = false;
  const check = () => {
    queued = false;
    if (controller.enabled && blocked()) controller.stop();
  };
  new MutationObserver(() => {
    if (queued || !controller.enabled) return;
    queued = true;
    queueMicrotask(check);
  }).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['type', 'autocomplete', 'name', 'id', 'placeholder', 'aria-label'],
  });
}

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
