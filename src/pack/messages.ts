// Messages for site language packs. Every type starts with "pack-" so the
// article content script can leave them to the pack script (both listen on
// runtime.onMessage in the same tab).
import type { ExploreReport } from './explorer';
import type { EntryWhere, PackIndexItem, PackRegion, SitePack } from './format';
import type { Candidate, StructuredCandidate } from './harvest';

/** background -> scan content script: start exploring (ids bind every reply to this scan). */
export interface ScanRun {
  type: 'pack-scan-run';
  scanId: string;
  nonce: string;
  packId: string;
  targetLang: string;
  regions: PackRegion[];
  excludes: string[];
}

export type ScanReport = ExploreReport & { strings: number; content: number };

/** What the popup / sites page shows about a scan. */
export interface ScanStatusView {
  running: boolean;
  packId?: string;
  progress?: { actions: number; visited: number; strings: number };
  last?: { at: number; report?: ScanReport; refused?: 'draft' | 'error' | 'interrupted' };
}

/** popup/options/background -> pack content script (tabs.sendMessage). */
export type PackTabCommand =
  | { type: 'pack-state' }
  | { type: 'pack-toggle'; on?: boolean }
  | { type: 'pack-pick-start'; packId: string; targetLang: string; regions: PackRegion[]; excludes: string[]; shortcut?: string }
  | { type: 'pack-pick-stop' }
  | ScanRun
  | { type: 'pack-scan-stop'; scanId: string }
  | { type: 'pack-scan-ping'; scanId: string };

export interface PackTabState {
  /** The pack script is running in this tab. */
  injected: true;
  packId?: string;
  targetLang?: string;
  /** Translations currently shown (false after "show original"). */
  active: boolean;
  applied: number;
  misses: number;
}

/** popup/options -> background (runtime.sendMessage). */
export type PackRequest =
  | { type: 'pack-list' }
  | { type: 'pack-get'; id: string }
  | { type: 'pack-save'; pack: unknown; enabled?: boolean; expectRev?: number }
  | { type: 'pack-delete'; id: string }
  /** Field-level edits from the sites page, applied in one store transaction (nothing else is overwritten). */
  | { type: 'pack-update'; id: string; patch: PackPatch }
  | { type: 'pack-entry-edit'; id: string; kind: string; src: string; ctx?: string; t?: string; remove?: boolean }
  | { type: 'pack-entries-stale'; id: string; op: 'mark' | 'clean' }
  | { type: 'pack-set-enabled'; id: string; enabled: boolean }
  /** Popup: create the pack if needed, inject the pack script, open the region picker. */
  | { type: 'pack-collect-start'; tabId: number; host: string; targetLang: string }
  /** Pack content script (host-checked): picked regions and excludes. */
  | { type: 'pack-regions-save'; id: string; regions: PackRegion[]; excludes: string[] }
  /** Pack content script (host-checked): candidate strings (approved regions, or anywhere for automatic scope). */
  | { type: 'pack-candidates-add'; id: string; candidates: (Candidate | StructuredCandidate)[] }
  /** Pack content script (host-checked): strings inside areas just marked as content; removed from pending. */
  | { type: 'pack-pending-drop'; id: string; strings: { kind: Candidate['kind']; src: string }[] }
  | { type: 'pack-pending-get'; id: string }
  | { type: 'pack-pending-clear'; id: string; keys?: string[] }
  /** Remove these occurrences and never collect their strings again. */
  | { type: 'pack-pending-ignore'; id: string; keys: string[] }
  | { type: 'pack-scan-clear'; id: string }
  /** Freeze a plan for these approved strings and return its exact requests (no network). */
  | { type: 'pack-plan'; id: string; keys: string[]; description: string }
  /** Run the frozen plan the user just confirmed (nothing else can be generated). */
  | { type: 'pack-generate'; id: string; planId: string }
  | { type: 'pack-job-get'; id: string }
  | { type: 'pack-job-cancel'; id: string }
  | { type: 'pack-job-resume'; id: string }
  /** Draft an app description from approved strings (sends them to the LLM; user-initiated). */
  | { type: 'pack-describe-plan'; id: string; keys: string[] }
  | { type: 'pack-describe'; id: string; planId: string }
  /**
   * Debug builds only, and only from hosts listed in settings.debugHosts: counts,
   * membership of strings the page itself supplies, and the original/translated toggle.
   * Never returns candidate or entry text.
   */
  | { type: 'pack-debug'; op: 'state' | 'contains' | 'toggle' | 'scan' | 'scan-summary'; needles?: string[]; on?: boolean }
  /** Popup / sites page: explore this tab (consent remembered per site). */
  | { type: 'pack-scan-start'; tabId: number; host: string; targetLang: string; consent?: boolean }
  | { type: 'pack-scan-cancel'; tabId: number }
  | { type: 'pack-scan-status'; tabId?: number; packId?: string }
  /** Scan content script (bound to the scan by id + nonce, tab, document and host). */
  | { type: 'pack-scan-candidates'; scanId: string; nonce: string; candidates: StructuredCandidate[] }
  | { type: 'pack-scan-progress'; scanId: string; nonce: string; actions: number; visited: number; strings: number }
  | { type: 'pack-scan-done'; scanId: string; nonce: string; report?: ScanReport; refused?: 'draft' | 'error' };

export interface PackPatch {
  name?: string;
  /** The first (primary) host cannot be removed: it names the pack. */
  hosts?: string[];
  scopes?: string[];
  description?: string;
  hydration?: 'after-idle' | 'immediate';
  learn?: boolean;
  scope?: 'auto' | 'regions';
  /** Regions / excludes to keep (the page only removes; the picker adds). */
  keepRegions?: string[];
  removeRegions?: string[];
  keepExcludes?: string[];
  removeExcludes?: string[];
}

export interface PlanView {
  planId: string;
  messages: { role: string; content: string }[][];
  items: number;
  destination: { name: string; baseURL: string; model: string };
  fallback?: { name: string; baseURL: string; model: string };
  estimate: string;
}

export interface PendingView {
  /** Identity of this occurrence (string + context), used for approval. */
  key: string;
  kind: Candidate['kind'];
  src: string;
  region: string;
  flags: Candidate['flags'];
  count: number;
  lastSeen: number;
  ctx?: string;
  where?: EntryWhere;
  tier: 'high' | 'uncertain';
  reason?: string;
  source?: 'pick' | 'scan' | 'learn';
  newContext?: boolean;
}

export type PackResponse =
  | {
      ok: true;
      index?: PackIndexItem[];
      pack?: SitePack;
      warnings?: string[];
      pending?: PendingView[];
      added?: number;
      plan?: PlanView;
      job?: unknown;
      text?: string;
      scan?: ScanStatusView;
    }
  | { ok: false; error: string };

export function isPackMessage(m: unknown): boolean {
  return typeof (m as { type?: unknown })?.type === 'string' && (m as { type: string }).type.startsWith('pack-');
}

export const STORAGE = {
  index: 'packIndex',
  pack: (id: string) => `pack:${id}`,
  runtime: (id: string) => `packrt:${id}`,
} as const;
