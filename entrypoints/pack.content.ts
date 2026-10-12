// Site language pack runtime. Registered at runtime (not in the manifest) only
// for hosts with an enabled pack, and injected on demand into already-open tabs.
// Keep imports to wxt/browser and src/pack/*: this bundle runs at document_start.
import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { PackApplier } from '../src/pack/applier';
import { joinSelectors } from '../src/pack/dom-rules';
import { selectPack, variantKey, type EntryKind, type PackIndexItem, type PackRegion, type PackRuntime } from '../src/pack/format';
import { collect, stringsIn, type StructuredCandidate } from '../src/pack/harvest';
import { Learner } from '../src/pack/learner';
import { whenSafeToApply } from '../src/pack/hydration';
import { isPackMessage, STORAGE, type PackRequest, type PackTabCommand, type PackTabState } from '../src/pack/messages';
import { RegionPicker } from '../src/pack/picker';

const FLUSH_MS = 5000;
/** Coalesce pack revisions (parallel generation lanes commit in quick succession). */
const RUNTIME_DEBOUNCE_MS = 300;
const HARVEST_DEBOUNCE_MS = 400;

/** Sends new candidates to the background in batches; each string + context once per page load. */
class CandidateSink {
  private sent = new Set<string>();
  private buffer: StructuredCandidate[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private packId: string) {}
  get size(): number {
    return this.sent.size;
  }
  push(list: StructuredCandidate[], immediate = false): void {
    for (const c of list) {
      const k = variantKey(c.kind, c.src, c.ctx);
      if (this.sent.has(k)) continue;
      this.sent.add(k);
      this.buffer.push(c);
    }
    if (!this.buffer.length) return;
    if (immediate) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.buffer.length) return;
    const candidates = this.buffer.splice(0);
    void browser.runtime.sendMessage({ type: 'pack-candidates-add', id: this.packId, candidates } satisfies PackRequest).catch(() => {});
  }
}

/** While the picker is open: harvest approved regions now and whenever the page changes. */
class Collector {
  private mo: MutationObserver | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  readonly sink: CandidateSink;
  constructor(
    packId: string,
    private targetLang: string,
    private state: () => { regions: PackRegion[]; excludes: string[] },
  ) {
    this.sink = new CandidateSink(packId);
  }
  start(): void {
    this.run();
    this.mo = new MutationObserver(() => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.run(), HARVEST_DEBOUNCE_MS);
    });
    this.mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
  }
  run(): void {
    const { regions, excludes } = this.state();
    if (!regions.length) return;
    const { candidates } = collect(document, { scope: 'regions', regions, targetLang: this.targetLang, exclude: joinSelectors(excludes) });
    this.sink.push(candidates.map((c) => ({ ...c, source: 'pick' as const })), true);
  }
  stop(): void {
    this.mo?.disconnect();
    clearTimeout(this.timer);
    this.sink.flush();
  }
}

const RUNNING = Symbol.for('translucid.pack.runtime');

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  registration: 'runtime',
  allFrames: false,
  main(ctx) {
    const g = globalThis as unknown as Record<symbol, boolean>;
    if (g[RUNNING]) return; // registered script and an on-demand injection may both arrive
    g[RUNNING] = true;
    ctx.onInvalidated(() => {
      g[RUNNING] = false;
    });

    let current: PackIndexItem | undefined;
    let applier: PackApplier | undefined;
    let runtime: PackRuntime | undefined;
    let showing = true;
    let abort: AbortController | undefined;
    let picker: RegionPicker | undefined;
    let collector: Collector | undefined;
    let misses: CandidateSink | undefined;
    let learner: Learner | undefined;

    /** A string the pack has no translation for: the learner decides (approved regions, or automatic learning). */
    const onMiss = (kind: EntryKind, src: string, el: Element) => learner?.offer(kind, src, el);

    const stop = () => {
      abort?.abort();
      applier?.restore();
      applier = undefined;
      learner?.stop();
      learner = undefined;
      misses?.flush();
      misses = undefined;
    };

    async function activate(item: PackIndexItem | undefined): Promise<void> {
      if (item?.id === current?.id && applier) return;
      stop();
      current = item;
      if (!item || !showing) return;
      const key = STORAGE.runtime(item.id);
      const rt = (await browser.storage.local.get(key))[key] as PackRuntime | undefined;
      if (!rt || ctx.isInvalid || current?.id !== item.id) return;
      abort = new AbortController();
      const signal = abort.signal;
      await whenSafeToApply(document, rt.hydration, signal);
      if (signal.aborted || ctx.isInvalid || current?.id !== item.id) return;
      runtime = rt;
      const sink = (misses = new CandidateSink(item.id));
      learner = new Learner(() => runtime, (c) => sink.push([c]));
      applier = new PackApplier(document, rt, {
        onMiss,
        // SPA route change: the active pack may change with the path scope.
        onNavigate: () => void reselect(),
      });
      applier.start();
    }

    async function reselect(): Promise<void> {
      const index = ((await browser.storage.local.get(STORAGE.index))[STORAGE.index] as PackIndexItem[] | undefined) ?? [];
      await activate(selectPack(index, location.hostname, location.pathname));
    }

    let pendingRuntime: PackRuntime | undefined;
    let runtimeTimer: ReturnType<typeof setTimeout> | undefined;
    const onStorage = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area !== 'local') return;
      if (STORAGE.index in changes) void reselect();
      const rtKey = current && STORAGE.runtime(current.id);
      if (rtKey && rtKey in changes && applier) {
        const rt = changes[rtKey]!.newValue as PackRuntime | undefined;
        if (!rt) return;
        pendingRuntime = rt;
        clearTimeout(runtimeTimer);
        runtimeTimer = setTimeout(() => {
          const next = pendingRuntime;
          pendingRuntime = undefined;
          if (!next || !applier || next.id !== current?.id) return;
          // In place: changed strings switch, removed ones show the original, the rest stays (no flash).
          applier.update(next);
          runtime = next;
        }, RUNTIME_DEBOUNCE_MS);
      }
    };
    browser.storage.onChanged.addListener(onStorage);

    const state = (): PackTabState => ({
      injected: true,
      packId: current?.id,
      targetLang: current?.targetLang,
      active: !!applier?.active,
      applied: applier?.stats.applied ?? 0,
      misses: applier?.stats.misses ?? 0,
    });

    const onMessage = (raw: unknown, _sender: unknown, sendResponse: (r: unknown) => void) => {
      if (!isPackMessage(raw)) return false;
      const cmd = raw as PackTabCommand;
      if (cmd.type === 'pack-toggle') {
        showing = cmd.on ?? !showing;
        if (showing) void reselect().then(() => sendResponse(state()));
        else {
          stop();
          sendResponse(state());
        }
        return true;
      }
      if (cmd.type === 'pack-state') {
        sendResponse(state());
        return false;
      }
      if (cmd.type === 'pack-pick-start') {
        picker?.close();
        collector?.stop();
        let live = { regions: cmd.regions, excludes: cmd.excludes };
        collector = new Collector(cmd.packId, cmd.targetLang, () => live);
        picker = new RegionPicker(document, live, {
          onChange: (s) => {
            // Areas newly marked as content: whatever was collected from them before is dropped.
            const added = s.excludes.filter((x) => !live.excludes.includes(x));
            if (added.length) {
              void browser.runtime
                .sendMessage({ type: 'pack-pending-drop', id: cmd.packId, strings: stringsIn(document, added) } satisfies PackRequest)
                .catch(() => {});
            }
            live = s;
            // Save first: the background only accepts candidates from regions it knows.
            void browser.runtime
              .sendMessage({ type: 'pack-regions-save', id: cmd.packId, regions: s.regions, excludes: s.excludes } satisfies PackRequest)
              .then(() => collector?.run())
              .catch(() => {});
          },
          onDone: () => {
            collector?.stop();
            collector = picker = undefined;
          },
          onCancel: () => {
            collector?.stop();
            collector = picker = undefined;
          },
          count: () => collector?.sink.size ?? 0,
          shortcut: cmd.shortcut,
        });
        picker.open();
        collector.start();
        sendResponse({ ok: true });
        return false;
      }
      if (cmd.type === 'pack-pick-stop') {
        picker?.close();
        collector?.stop();
        picker = undefined;
        collector = undefined;
        sendResponse({ ok: true });
        return false;
      }
      return false;
    };
    browser.runtime.onMessage.addListener(onMessage);

    ctx.onInvalidated(() => {
      browser.storage.onChanged.removeListener(onStorage);
      browser.runtime.onMessage.removeListener(onMessage);
      stop();
    });

    void reselect();
  },
});
