// Checks for generated UI translations. Shares the hard rules with imports
// (format.translationProblem: single line, no markup, same placeholders, sane
// length) and adds glossary consistency. Script checks are hints only.
import { termRespected } from '../prompt/glossary';
import { translationProblem, type PackGlossaryEntry } from '../pack/format';
import type { GlossaryEntry } from '../shared/types';

export type UiVerdict = { ok: true; hint?: string } | { ok: false; reason: string };

const SCRIPT_RE: Record<string, RegExp> = {
  zh: /[㐀-鿿]/,
  ja: /[぀-ヿ㐀-鿿]/,
  ko: /[가-힯]/,
  ru: /[Ѐ-ӿ]/,
  uk: /[Ѐ-ӿ]/,
  ar: /[؀-ۿ]/,
  he: /[֐-׿]/,
  hi: /[ऀ-ॿ]/,
  th: /[฀-๿]/,
};

export function validateUiTranslation(src: string, out: string, targetLang: string, glossary: PackGlossaryEntry[] = []): UiVerdict {
  const problem = translationProblem(src, out);
  if (problem) return { ok: false, reason: problem };
  const hits = glossary.filter((g) => new RegExp(`\\b${g.src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(src));
  const missed = hits.filter((g) => !termRespected({ src: g.src, tgt: g.tgt } as GlossaryEntry, out));
  if (missed.length) return { ok: false, reason: `glossary: ${missed.map((m) => m.src).join(', ')}` };
  const script = SCRIPT_RE[targetLang.split('-')[0]!.toLowerCase()];
  // Names and codes legitimately stay in the source script: only a hint, never a rejection.
  if (script && out === src && /[A-Za-z]{3,}/.test(src) && !script.test(out)) return { ok: true, hint: 'unchanged' };
  return { ok: true };
}
