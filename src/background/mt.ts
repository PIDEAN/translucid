import { vendorOf } from '../shared/pricing';
import type { ProviderConfig } from '../shared/types';
import { HttpError, parseRetryAfter } from './providers';

// Keyless machine translation for short UI strings (menus, buttons, tabs).
// Neither endpoint is a documented public API: they are the ones Google's
// translate widget (client=gtx) and Edge's built-in translator use, as many
// translation extensions do. They can change or throttle without notice, so
// the session falls back to the main LLM provider on any failure.
//
// Callers send plain text only: no inline tags, placeholders or glossary
// terms, which these engines cannot honour.

/**
 * Whether a short plain string is safe to give a context-free engine. On GitHub
 * and TechPowerUp (2026-10-11) Google turned Copilot → 副驾驶, typescript → 打字稿,
 * Rust → 铁锈, main → 主要, Blackwell → 布莱克威尔, board partner → 董事会合伙人.
 * Names, tags, identifiers and tech pages go to the LLM, which keeps names and
 * knows the domain; ordinary UI phrases elsewhere go to machine translation.
 */
export function mtSuitable(text: string, scene?: string): boolean {
  // Tech pages: short strings are jargon and names (Reviews → 评测, not 评论; board partner → 板卡合作伙伴).
  // The LLM sees the page's scene; with the system prompt cached, short batches cost little.
  if (scene === 'tech') return false;
  const t = text.trim();
  const words = t.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
  if (!words.length) return true;
  // Bylines and handles: "16:21 by Pellwick" became "通过佩尔威克".
  if (/\bby\s+\S/.test(t) || t.includes('@')) return false;
  // Letters mixed with digits: usernames and model numbers (Nym8ra, RTX5090, 4070Ti).
  if (words.some((w) => /[A-Za-z]\d|\d[A-Za-z]{2,}/.test(w))) return false;
  // Lowercase single word: topic tags, branch names, usernames, package names.
  if (words.length === 1 && !/[A-Z]/.test(words[0]!)) return false;
  // Acronyms and brand casing (MIT, CSS, README, iOS, GitHub).
  if (words.some((w) => /[A-Z]{2,}/.test(w) || /[a-z][A-Z]/.test(w))) return false;
  return true;
}

const GOOGLE_CHARS = 4000;
const MICROSOFT_ITEMS = 100;
const MICROSOFT_CHARS = 10_000;

function chunk(texts: string[], maxChars: number, maxItems: number): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let chars = 0;
  for (const t of texts) {
    if (cur.length && (chars + t.length > maxChars || cur.length >= maxItems)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(t);
    chars += t.length + 1;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function request(p: ProviderConfig, url: string, init: RequestInit): Promise<any> {
  const res = await fetch(url, init);
  if (!res.ok) throw new HttpError(res.status, `${p.name} HTTP ${res.status}`, parseRetryAfter(res.headers.get('retry-after')));
  return res.json();
}

const origin = (p: ProviderConfig) => p.baseURL.replace(/\/+$/, '');

/** One POST with lines joined by "\n"; Google keeps one output sentence group per input line. */
async function google(p: ProviderConfig, texts: string[], signal?: AbortSignal): Promise<string[]> {
  const call = async (q: string) => {
    const json = await request(p, `${origin(p)}/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ q }),
      signal,
    });
    if (!Array.isArray(json?.[0])) throw new HttpError(502, `${p.name} 返回格式有误`);
    return (json[0] as unknown[][]).map((s) => (typeof s?.[0] === 'string' ? s[0] : '')).join('');
  };
  const out: string[] = [];
  for (const group of chunk(texts, GOOGLE_CHARS, Infinity)) {
    const lines = (await call(group.join('\n'))).split('\n');
    if (lines.length === group.length) out.push(...lines);
    // Line structure lost: translate this group one string at a time.
    else for (const t of group) out.push(await call(t));
  }
  return out;
}

async function microsoft(p: ProviderConfig, texts: string[], signal?: AbortSignal): Promise<string[]> {
  const out: string[] = [];
  for (const group of chunk(texts, MICROSOFT_CHARS, MICROSOFT_ITEMS)) {
    const json = await request(p, `${origin(p)}/translate/translatetext?from=&to=zh-Hans&isEnterpriseClient=false`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(group),
      signal,
    });
    if (!Array.isArray(json) || json.length !== group.length) throw new HttpError(502, `${p.name} 返回格式有误`);
    out.push(...json.map((r: any) => String(r?.translations?.[0]?.text ?? '')));
  }
  return out;
}

/** Translates plain strings to Simplified Chinese, same order and count as the input. */
export async function machineTranslate(p: ProviderConfig, texts: string[], signal?: AbortSignal): Promise<string[]> {
  // Line breaks would break Google's line pairing; short UI strings never need them.
  const clean = texts.map((t) => t.replace(/\s+/g, ' ').trim());
  const out = vendorOf(p) === 'google-translate' ? await google(p, clean, signal) : await microsoft(p, clean, signal);
  return out.map((t) => t.trim());
}
