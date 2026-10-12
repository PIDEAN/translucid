import type { GlossaryEntry } from '../shared/types';

export const KEEP = 'KEEP';

/** Parse `src => tgt # note` lines. Blank lines and lines starting with # are ignored. */
export function parseGlossary(text: string | undefined): GlossaryEntry[] {
  if (!text) return [];
  const out: GlossaryEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(.+?)\s*(?:=>|→)\s*(.+?)(?:\s+#\s*(.*))?$/);
    if (!m) continue;
    const src = m[1]!.trim();
    const tgt = m[2]!.trim();
    const n = m[3]?.trim();
    if (!src || !tgt) continue;
    out.push(n ? { src, tgt, note: n } : { src, tgt });
  }
  return out;
}

/** Later entries override earlier ones with the same source (site > page > global order is the caller's job). */
export function mergeGlossaries(...lists: GlossaryEntry[][]): GlossaryEntry[] {
  const map = new Map<string, GlossaryEntry>();
  for (const list of lists) for (const e of list) map.set(e.src.toLowerCase(), e);
  return [...map.values()];
}

const reCache = new Map<string, RegExp>();

function termRegExp(src: string): RegExp {
  let re = reCache.get(src);
  if (!re) {
    const escaped = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pre = /^\w/.test(src) ? '(?<![\\w-])' : '';
    const post = /\w$/.test(src) ? '(?![\\w-])' : '';
    // All-lowercase terms match case-insensitively; anything with capitals is
    // treated as a proper noun ("Apple" must not match "apple").
    re = new RegExp(pre + escaped + post, src === src.toLowerCase() ? 'i' : '');
    reCache.set(src, re);
  }
  return re;
}

export function findHits(entries: GlossaryEntry[], text: string): GlossaryEntry[] {
  return entries.filter((e) => termRegExp(e.src).test(text));
}

/** True when the translation honours the term (target used, or source kept for KEEP). */
export function termRespected(e: GlossaryEntry, translation: string): boolean {
  if (e.tgt === KEEP) return translation.toLowerCase().includes(e.src.toLowerCase());
  return translation.includes(e.tgt);
}

/** Deterministic serialization so identical hit sets give identical prompt bytes. */
export function formatGlossary(entries: GlossaryEntry[]): string {
  return [...entries]
    .sort((a, b) => (a.src < b.src ? -1 : a.src > b.src ? 1 : 0))
    .map((e) => {
      const tgt = e.tgt === KEEP ? '(keep original)' : e.tgt;
      return `- ${e.src} => ${tgt}${e.note ? ` (${e.note})` : ''}`;
    })
    .join('\n');
}

/** Inverse of parseGlossary, for editors that work on entries. */
export function serializeGlossary(entries: GlossaryEntry[]): string {
  return entries.map((e) => `${e.src} => ${e.tgt}${e.note ? ` # ${e.note}` : ''}`).join('\n');
}
