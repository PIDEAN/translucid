// One-click scans: the background issues a scan id + nonce per tab, injects
// the scan script, and accepts its messages only from that tab, document and
// host while the scan lasts. Reports (counts and interface labels only) are
// kept per pack for 30 days.
import { browser } from 'wxt/browser';
import type { ScanReport, ScanStatusView } from '../pack/messages';
import { textFlags } from '../pack/privacy';

export const SCAN_SCRIPT_FILE = '/content-scripts/scan.js' as const;
const REPORT_TTL_MS = 30 * 86_400_000;
const CONSENT_KEY = 'scanConsent';
const recordKey = (tabId: number) => `scan:${tabId}`;
const reportKey = (packId: string) => `scanReport:${packId}`;

export interface ScanRecord {
  scanId: string;
  nonce: string;
  tabId: number;
  host: string;
  packId: string;
  documentId?: string;
  startedAt: number;
  progress?: { actions: number; visited: number; strings: number };
}

const session = () => browser.storage.session ?? browser.storage.local;
const random = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function hasConsent(host: string): Promise<boolean> {
  const list = ((await browser.storage.local.get(CONSENT_KEY))[CONSENT_KEY] as string[] | undefined) ?? [];
  return list.includes(host);
}

export async function grantConsent(host: string): Promise<void> {
  const list = ((await browser.storage.local.get(CONSENT_KEY))[CONSENT_KEY] as string[] | undefined) ?? [];
  if (!list.includes(host)) await browser.storage.local.set({ [CONSENT_KEY]: [...list, host] });
}

export async function getRecord(tabId: number): Promise<ScanRecord | undefined> {
  return (await session().get(recordKey(tabId)))[recordKey(tabId)] as ScanRecord | undefined;
}

export async function createRecord(tabId: number, host: string, packId: string): Promise<ScanRecord> {
  const rec: ScanRecord = { scanId: random(), nonce: random(), tabId, host, packId, startedAt: Date.now() };
  await session().set({ [recordKey(tabId)]: rec });
  return rec;
}

export async function updateRecord(rec: ScanRecord): Promise<void> {
  await session().set({ [recordKey(rec.tabId)]: rec });
}

export async function clearRecord(tabId: number): Promise<void> {
  await session().remove(recordKey(tabId));
}

/**
 * The scan a content-script message belongs to: same tab, same scan id and
 * nonce, same host, and (when the browser reports it) the same document.
 */
export async function recordForSender(
  msg: { scanId?: unknown; nonce?: unknown },
  sender: { tab?: { id?: number; url?: string }; documentId?: string },
): Promise<ScanRecord | undefined> {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return undefined;
  const rec = await getRecord(tabId);
  if (!rec || rec.scanId !== msg.scanId || rec.nonce !== msg.nonce) return undefined;
  let host = '';
  try {
    host = new URL(sender.tab?.url ?? '').hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (host !== rec.host) return undefined;
  if (rec.documentId && sender.documentId && rec.documentId !== sender.documentId) return undefined;
  return rec;
}

const MAX_LABELS = 200;
const safeLabel = (s: unknown) => typeof s === 'string' && s.length <= 120 && !textFlags(s).some((f) => f !== 'identifier' && f !== 'number');

/** Keep counts and interface labels only; anything that looks personal is dropped. */
export function sanitizeReport(raw: unknown): ScanReport | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
  const labels = (v: unknown) => (Array.isArray(v) ? v.filter(safeLabel).slice(0, MAX_LABELS) as string[] : []);
  const skipped = Array.isArray(r.skipped)
    ? (r.skipped as { label?: unknown; reason?: unknown; count?: unknown }[])
        .filter((s) => (s?.reason === '指向个人内容' || safeLabel(s?.label)) && typeof s?.reason === 'string' && s.reason.length <= 40)
        .slice(0, MAX_LABELS)
        .map((s) => s.reason === '指向个人内容' ? { label: '个人内容链接', reason: s.reason, count: Math.max(1, num(s.count)) } : { label: s.label as string, reason: s.reason as string })
    : [];
  return {
    visited: labels(r.visited),
    skipped,
    actions: num(r.actions),
    ms: num(r.ms),
    ...(r.budgetHit === 'actions' || r.budgetHit === 'time' ? { budgetHit: r.budgetHit } : {}),
    ...(r.stopped === true ? { stopped: true } : {}),
    ...(r.refused === 'draft' ? { refused: 'draft' as const } : {}),
    ...(typeof r.guard === 'string' ? { guard: safeLabel(r.guard) ? r.guard : '（已隐藏）' } : {}),
    restore: r.restore === 'partial' ? 'partial' : 'full',
    unrestored: labels(r.unrestored),
    strings: num(r.strings),
    content: num(r.content),
  };
}

export async function saveReport(packId: string, report: ScanReport | undefined, refused?: 'draft' | 'error' | 'interrupted'): Promise<void> {
  await browser.storage.local.set({ [reportKey(packId)]: { at: Date.now(), ...(report ? { report } : {}), ...(refused ? { refused } : {}) } });
}

export async function clearReport(packId: string): Promise<void> {
  await browser.storage.local.remove(reportKey(packId));
}

export async function lastReport(packId: string): Promise<ScanStatusView['last']> {
  const v = (await browser.storage.local.get(reportKey(packId)))[reportKey(packId)] as ScanStatusView['last'] | undefined;
  if (v && Date.now() - v.at > REPORT_TTL_MS) {
    await browser.storage.local.remove(reportKey(packId));
    return undefined;
  }
  return v;
}

/** A record older than this belongs to a scan that died without reporting (budget is 2 minutes). */
export const STALE_SCAN_MS = 5 * 60_000;

/** The running scan of a pack, in whatever tab. */
async function recordForPack(packId: string): Promise<ScanRecord | undefined> {
  const all = await session().get(null);
  return Object.entries(all).find(([k, v]) => k.startsWith('scan:') && (v as ScanRecord).packId === packId)?.[1] as ScanRecord | undefined;
}

/**
 * Is the scan behind this record still running? Its script must answer in that very document; a
 * reloaded, navigated or closed tab (or a scan past its budget) ends it, recorded as interrupted.
 */
export async function liveRecord(rec: ScanRecord | undefined): Promise<ScanRecord | undefined> {
  if (!rec) return undefined;
  let alive = Date.now() - rec.startedAt < STALE_SCAN_MS;
  if (alive) {
    try {
      const r = (await browser.tabs.sendMessage(rec.tabId, { type: 'pack-scan-ping', scanId: rec.scanId }, rec.documentId ? { documentId: rec.documentId } : {})) as { alive?: boolean } | undefined;
      alive = r?.alive === true;
    } catch {
      alive = false;
    }
  }
  if (alive) return rec;
  await clearRecord(rec.tabId);
  await saveReport(rec.packId, undefined, 'interrupted');
  return undefined;
}

export async function scanStatus(tabId: number | undefined, packId: string | undefined): Promise<ScanStatusView> {
  const found = tabId !== undefined ? await getRecord(tabId) : packId ? await recordForPack(packId) : undefined;
  const rec = await liveRecord(found);
  const id = rec?.packId ?? packId;
  return { running: !!rec, ...(id ? { packId: id } : {}), ...(rec?.progress ? { progress: rec.progress } : {}), ...(id ? { last: await lastReport(id) } : {}) };
}
