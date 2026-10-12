import type { DisplayMode, PageContext, PageInfo, ProviderConfig, SegmentPayload } from './types';

export const PORT_NAME = 'xt-translate';

/** content -> background over the long-lived port. */
export type ToBackground =
  | { type: 'translate'; ctx: PageContext; segments: SegmentPayload[]; expertOverride?: string }
  | { type: 'preprocess'; ctx: PageContext; article: string }
  | { type: 'refine'; ctx: PageContext; segment: SegmentPayload; expertOverride?: string }
  /** Drop cached translations of these segments so they are translated again. */
  | { type: 'purge'; ctx: PageContext; texts: string[]; expertOverride?: string }
  | { type: 'reset' };

/** background -> content over the port. */
export type ToContent =
  | { type: 'result'; id: number; text: string; cached?: boolean; plain?: boolean }
  | { type: 'error'; ids: number[]; message: string }
  | { type: 'refined'; id: number; text: string }
  | { type: 'expert'; id: string; name: string }
  | { type: 'page-info'; info: PageInfo }
  | { type: 'purged' }
  /** Per-request timing (always); usage and validation rejects in debug builds. */
  | { type: 'metric'; data: { ttftMs?: number; totalMs?: number; kind?: string } & Record<string, unknown> };

/** popup/background -> content via tabs.sendMessage. */
export type TabCommand =
  | { type: 'toggle' }
  | { type: 'set-enabled'; enabled: boolean }
  | { type: 'set-mode'; mode: DisplayMode }
  | { type: 'toggle-mode' }
  | { type: 'set-expert'; expertId: string }
  | { type: 'refine-at-cursor' }
  /** 精翻 the paragraph holding the current text selection (popup quick action). */
  | { type: 'refine-selection' }
  | { type: 'retry-failed' }
  | { type: 'purge-page' }
  | { type: 'get-state' };

export interface TabState {
  enabled: boolean;
  mode: DisplayMode;
  expertOverride: string;
  /** Expert the background resolved for this page. */
  resolvedExpert: { id: string; name: string } | null;
  stats: { segments: number; done: number; errors: number; pending: number };
  /** ms from start() to the first rendered translation. */
  firstPaintMs: number | null;
  avgTtftMs: number | null;
  /** Page language (html lang, or a guess from the text). */
  lang: string;
  /** Translatable segments on the page, computed on demand while translation is off. */
  estimate: number | null;
  pageInfo: PageInfo | null;
  /** The current text selection sits in a translated paragraph. */
  selectionInSegment: boolean;
  /**
   * While on: translatable segments in documents of the tab that are still off (a page frame the
   * global auto-translate did not reach). Only set on a combined state (src/shared/frame-state.ts).
   */
  rest?: number | null;
}

/** popup/options -> background via runtime.sendMessage. */
export type RuntimeRequest =
  | { type: 'test-provider'; provider: ProviderConfig }
  | { type: 'openrouter-free-models' }
  | { type: 'cache-clear' }
  | { type: 'cache-count' }
  | { type: 'usage' }
  /** Debug builds only: reload the unpacked extension from disk. */
  | { type: 'reload-ext' }
  /** Debug builds only: report provider routing (key presence only) and optionally switch it. */
  | { type: 'debug-provider'; active?: string; short?: string; fallback?: string }
  /** A page-sized frame joining its page asks what the user chose there so far (answered by the top document). */
  | { type: 'frame-join' };

/**
 * What the user chose for the page in the top document's lifetime (popup, shortcuts, context menu).
 * The top document is the one source of it; frames follow (src/content/page-intent.ts). null: no choice
 * yet. `doc` names the top document (a new one after each navigation); `version` grows with every page
 * command, so a frame never applies another page's intent, or an older one over a newer one.
 */
export interface PageIntent {
  doc: string;
  version: number;
  enabled: boolean | null;
  mode: DisplayMode | null;
  expertId: string | null;
}

/** background -> top document: the page intent, for a joining frame. */
export type PageIntentRequest = { type: 'page-intent' };

/** The top document's reply to a command: its state, plus the page intent after the command. */
export type TopReply = TabState & { intent?: PageIntent };
