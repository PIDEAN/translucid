// A tab's page translation can run in several documents: the top one and page-sized frames
// (src/content/frames.ts). The popup and the keyboard commands treat them as one page.
import type { PageIntent, TabCommand, TabState } from './messages';

/**
 * Page-wide commands: they go to the top document alone, which applies them and hands the result to its
 * frames (src/content/page-intent.ts). The other commands act in every document on its own text.
 */
export const PAGE_COMMANDS: ReadonlySet<TabCommand['type']> = new Set(['toggle', 'set-enabled', 'set-mode', 'toggle-mode', 'set-expert']);

/** Name of the getter each translating document exposes in the extension's isolated world. */
export const FRAME_STATE_GETTER = '__translucidFrameState';
/** Name of the function a frame exposes there to take over the top document's page intent. */
export const FRAME_INTENT_SETTER = '__translucidApplyIntent';

/**
 * What the getter returns: the document's state, and for the page intent the top document's current
 * one (`intent`) or, in a frame, the one it follows (`follows`).
 */
export interface FrameReport {
  state: TabState;
  intent?: PageIntent;
  follows?: { doc: string | null; version: number };
}

/** Frames that fell behind the top document's intent (a lost update) and should get it again. */
export function staleFrames(reports: { frameId: number; report: FrameReport }[]): { intent: PageIntent; frameIds: number[] } | null {
  const intent = reports.find((r) => r.frameId === 0)?.report.intent;
  if (!intent) return null;
  const frameIds = reports
    .filter((r) => r.frameId !== 0 && r.report.follows)
    .filter(({ report: { follows } }) => (follows!.doc === null || follows!.doc === intent.doc) && follows!.version < intent.version)
    .map((r) => r.frameId);
  return frameIds.length ? { intent, frameIds } : null;
}

export interface FrameState {
  frameId: number;
  state: TabState;
}

/** The document holding most of the page's text: the one that names the language, expert and page. */
function mainOf(states: TabState[]): TabState {
  const weight = (s: TabState) => (s.enabled ? s.stats.segments : (s.estimate ?? 0));
  return states.reduce((best, s) => (weight(s) > weight(best) ? s : best), states[0]!);
}

/** One state for the tab: counts added up over the documents, details from the one holding the text. */
export function combineStates(parts: FrameState[]): TabState | null {
  if (!parts.length) return null;
  const ordered = [...parts].sort((a, b) => a.frameId - b.frameId);
  const all = ordered.map((p) => p.state);
  if (all.length === 1) return all[0]!;
  const top = ordered[0]!.frameId === 0 ? all[0]! : null;
  // On when any document translates, so 显示原文 and Alt+A always restore the page. Text in documents
  // still off (a page frame auto-translate did not reach) is reported as `rest` for the popup to offer.
  const enabled = all.some((s) => s.enabled);
  const main = mainOf(all);
  const live = all.filter((s) => s.enabled);
  const total = (k: keyof TabState['stats']) => all.reduce((n, s) => n + s.stats[k], 0);
  const known = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null);
  const paints = known(all.map((s) => s.firstPaintMs));
  const ttfts = known(all.map((s) => s.avgTtftMs));
  const estimates = known(all.map((s) => s.estimate));
  const offText = estimates.reduce((a, b) => a + b, 0);
  return {
    ...main,
    enabled,
    mode: (main.enabled ? main : (live[0] ?? main)).mode,
    expertOverride: (top ?? main).expertOverride,
    stats: { segments: total('segments'), done: total('done'), errors: total('errors'), pending: total('pending') },
    firstPaintMs: paints.length ? Math.min(...paints) : null,
    avgTtftMs: ttfts.length ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : null,
    estimate: enabled || !estimates.length ? null : offText,
    rest: enabled && offText > 0 ? offText : null,
    selectionInSegment: all.some((s) => s.selectionInSegment),
  };
}
