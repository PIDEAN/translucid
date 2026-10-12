import { termRespected } from '../prompt/glossary';
import { ATOM_RE, cjkRatio, countLetters, isMostlyChinese, stripMarkup, TAG_RE } from '../shared/text';
import type { GlossaryEntry } from '../shared/types';

export type Verdict =
  | { ok: true }
  | { ok: false; reason: string; /** soft failures are accepted after one retry */ soft?: boolean };

const sortedTokens = (s: string) => [...(s.match(TAG_RE) ?? []), ...(s.match(ATOM_RE) ?? [])].sort();

/**
 * Repair model markup before validation: "< i1>" / "</ a1 >" are normalised, and
 * tags whose id does not exist in the source are removed, so nothing tag-like is
 * ever rendered as literal text.
 */
export function sanitizeMarkup(src: string, out: string): string {
  const known = new Set((src.match(/<[a-z]\d+>/g) ?? []).map((t) => t.slice(1, -1)));
  return out
    .replace(/<\s*(\/?)\s*([a-z])\s*(\d+)\s*>/g, '<$1$2$3>')
    .replace(/<(\/?)([a-z])(\d+)>/g, (m, _c, l, d) => (known.has(`${l}${d}`) ? m : ''));
}

/** Opening tags / atoms present in the source but absent from the output. */
export function missingTokens(src: string, out: string): string[] {
  const have = new Set(out.match(/<[a-z]\d+>|\{\{\d+\}\}/g) ?? []);
  return (src.match(/<[a-z]\d+>|\{\{\d+\}\}/g) ?? []).filter((t) => !have.has(t));
}

export function tagsMatch(src: string, out: string): boolean {
  const a = sortedTokens(src);
  const b = sortedTokens(out);
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

const STRAY_WORDS = new Set(
  ('the an and or but of to in on at by for with from into onto than then when where while which who whom whose that this these those ' +
    'is are was were be been being has have had do does did will would can could should may might must ' +
    'later also often still only just very really already again ever never always usually however therefore thus although though because since until unless ' +
    'about above after before below between during through under over around among against without within').split(' '),
);
// Between Han characters, or between Han and a capitalised name ("99 条评论 on NVIDIA").
const STRAY_RE = /[\u3400-\u9fff]\s*([a-z]+)(?:\s*(?=[\u3400-\u9fff])|\s+(?=[A-Z]))/g;

/** First English function word found between Han characters, if any. */
export function strayEnglish(out: string): string | undefined {
  for (const m of out.matchAll(STRAY_RE)) if (STRAY_WORDS.has(m[1]!)) return m[1];
  return undefined;
}

/** Cheap local checks; anything failing is retried with a smaller batch or alone. */
export function validateTranslation(src: string, out: string, hits: GlossaryEntry[] = []): Verdict {
  if (!out.trim()) return { ok: false, reason: 'empty' };
  if (/<\/?\d+>/.test(out)) return { ok: false, reason: 'leaked segment tag' };
  // Severity of lost markup (measured on Wikipedia: models often fold an emphasised
  // word into Chinese grammar and drop <i4>not</i4>; retrying that wasted 3 calls and
  // ended in a plain-text fallback that also lost every link):
  //   atoms ({{n}} = code/images) lost → content lost, hard failure
  //   links (<aN>) lost → soft, retried once
  //   formatting (<bN>/<iN>/<xN>) lost → accepted; invented/duplicate tags are ignored on render
  const missing = missingTokens(src, out);
  if (missing.some((t) => t.startsWith('{{'))) return { ok: false, reason: 'missing atoms' };

  const s = stripMarkup(src).trim();
  const o = stripMarkup(out).trim();
  const srcLetters = countLetters(s);
  const srcIsChinese = isMostlyChinese(s);

  if (srcLetters >= 20) {
    const ratio = o.length / Math.max(1, s.length);
    // Terms and headings compress hard (Dimensionality reduction → 降维, ratio 0.08),
    // so the lower bound only applies to sentence-length text.
    // Character ratio: English → Chinese usually lands around 0.3–0.6,
    // Japanese → Chinese around 1. Outside this window something broke.
    if (ratio < 0.12 && srcLetters >= 80) return { ok: false, reason: `too short (${ratio.toFixed(2)})` };
    if (ratio > 3) return { ok: false, reason: `too long (${ratio.toFixed(2)})` };
  }

  if (!srcIsChinese && srcLetters >= 15) {
    // Echoing a name or a 1–2 word label is legitimate (SKIP rule); only sentences must change.
    // Soft: titles and proper names are legitimately kept (paper titles, product names); one retry, then accept.
    // Names and products are echoed on purpose (NVIDIA GeForce 617.42 WHQL, a username
    // like "Quiet Harbor Lamp"); only text with ordinary lowercase words must change.
    const words = s.split(/\s+/);
    const nameLike = words.every((w) => !/[a-z]/i.test(w[0] ?? '') || /^[^a-z]*[A-Z]/.test(w));
    if (o === s && words.length >= 3 && !nameLike) return { ok: false, soft: true, reason: 'untranslated' };
    // Tech text keeps plenty of English, but zero Han characters means the
    // model echoed or answered in the wrong language.
    if (cjkRatio(o) === 0 && words.length >= 4 && !nameLike) return { ok: false, soft: true, reason: 'no Chinese in output' };
  }

  if (missing.some((t) => t.startsWith('<a'))) return { ok: false, soft: true, reason: 'missing links' };

  // A function word sitting between Chinese characters is an untranslated leftover
  // ("构想 later 在 17 世纪"); kept terms like commit/token are nouns, never in this list.
  const stray = !srcIsChinese && strayEnglish(o);
  if (stray) return { ok: false, soft: true, reason: `stray English: ${stray}` };

  const missed = hits.filter((h) => !termRespected(h, out));
  if (missed.length) return { ok: false, soft: true, reason: `glossary: ${missed.map((m) => m.src).join(', ')}` };
  return { ok: true };
}
