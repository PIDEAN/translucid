// Privacy checks for site language packs. Packs must hold UI chrome only, never
// user content (chat titles, names, emails). These are the string-level checks;
// DOM-level ones (approved regions, user-content containers, inputs) live in
// harvest.ts. A flagged candidate is shown unchecked with its reason; nothing is
// sent without the user's per-string approval.
import { cjkRatio, countLetters, looksLikeIdentifier, looksLikeNameList } from '../shared/text';
import { LIMITS, validatePack, type SitePack } from './format';
import { EMAIL_RE, HANDLE_RE, PHONE_RE, URL_RE, redactContactData } from './hardflags';

export type PrivacyFlag =
  | 'long'
  | 'email'
  | 'url'
  | 'phone'
  | 'number'
  | 'date'
  | 'handle'
  | 'identifier'
  | 'names'
  | 'no-letters'
  | 'already-target'
  | 'personal-link'
  | 'possible-name';

/**
 * Strings with these flags are dropped at collection and never stored, not even
 * for review: links to one specific item (chat titles), contact data, handles.
 * Softer flags only untick a candidate in the review list.
 */
export const HARD_FLAGS: ReadonlySet<PrivacyFlag> = new Set(['personal-link', 'email', 'phone', 'handle', 'url']);
export const isHardFlagged = (flags: PrivacyFlag[]) => flags.some((f) => HARD_FLAGS.has(f));

/** Upper-case acronyms common in interfaces (not names). */
const UI_ACRONYMS = new Set(['OK', 'API', 'APIS', 'FAQ', 'AI', 'UI', 'URL', 'PDF', 'CSV', 'JSON', 'HTML', 'CSS', 'SQL', 'NEW', 'PRO', 'BETA', 'FREE', 'BETA', 'MAX', 'PLUS', 'TEAM', 'ID', 'SSO', 'MCP', 'CLI', 'SDK', 'IDE', 'GPU', 'CPU', 'USD', 'EUR']);

export const FLAG_LABELS: Record<PrivacyFlag, string> = {
  long: '过长，像正文',
  email: '含邮箱',
  url: '含网址',
  phone: '含电话号码',
  number: '纯数字',
  date: '日期或时间',
  handle: '含 @ 用户名',
  identifier: '像标识符或文件名',
  names: '像人名列表',
  'no-letters': '没有文字',
  'already-target': '已是目标语言',
  'personal-link': '指向个人内容的链接（会话、文档等）',
  'possible-name': '可能是名字或缩写',
};

const NUMBER_ONLY_RE = /^[\d\s.,:+%$€£¥-]+$/;
const DATE_RE =
  /^(?:\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}|\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)?,? ?\d{0,4})$/i;

/** Reasons a UI string looks like user content or is not worth translating. */
export function textFlags(text: string, targetLang?: string): PrivacyFlag[] {
  const t = text.trim();
  const flags: PrivacyFlag[] = [];
  if (countLetters(t) === 0) flags.push('no-letters');
  if (t.length > LIMITS.keyChars || t.split(/\s+/).length > 12) flags.push('long');
  if (EMAIL_RE.test(t)) flags.push('email');
  else if (URL_RE.test(t)) flags.push('url');
  if (PHONE_RE.test(t)) flags.push('phone');
  if (HANDLE_RE.test(t)) flags.push('handle');
  if (NUMBER_ONLY_RE.test(t)) flags.push('number');
  if (DATE_RE.test(t)) flags.push('date');
  if (looksLikeIdentifier(t) && !flags.includes('email') && !flags.includes('url')) flags.push('identifier');
  if (looksLikeNameList(t)) flags.push('names');
  // A lone upper-case token is often a display name or initials ("MIRACHEN", "MC" in an account menu);
  // a possessive is someone's thing ("Acme's Workspace", "Mira’s team").
  if ((/^[A-Z][A-Z.'-]{1,30}$/.test(t) && !UI_ACRONYMS.has(t)) || /^\p{Lu}[\p{L}\d.&-]*(?: \p{Lu}[\p{L}\d.&-]*)?['’]s\b/u.test(t)) flags.push('possible-name');
  if (targetLang && alreadyInTarget(t, targetLang)) flags.push('already-target');
  return flags;
}

/** Script-level guess that a string is already in the target language (CJK targets only). */
export function alreadyInTarget(text: string, targetLang: string): boolean {
  const lang = targetLang.toLowerCase();
  if (lang.startsWith('zh')) return cjkRatio(text) > 0.5 && !/[぀-ヿ가-힯]/.test(text);
  if (lang.startsWith('ja')) return /[぀-ヿ]/.test(text);
  if (lang.startsWith('ko')) return /[가-힯]/.test(text);
  return false;
}

/**
 * A URL path segment or query value that names one specific item: UUIDs, long
 * hex, and mixed letter+digit tokens of 6+ chars (short ids such as /c/a1b2c3).
 */
export function idLikeSegment(seg: string, decoded = false): boolean {
  let s = seg;
  if (!decoded) {
    try {
      s = decodeURIComponent(seg);
    } catch {
      return true; // undecodable: treat as opaque (an id), the conservative answer
    }
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
  if (/^[0-9a-f]{16,}$/i.test(s)) return true;
  if (/^\d{4,}$/.test(s)) return true;
  return /^[A-Za-z0-9_-]{6,}$/.test(s) && /\d/.test(s) && /[A-Za-z]/.test(s);
}

/**
 * Link text pointing at one specific item (a conversation, document, project)
 * is almost always user content: chat titles in a sidebar, recent files.
 */
export function hrefLooksPersonal(href: string, base = 'https://example.invalid/'): boolean {
  let u: URL;
  try {
    u = new URL(href, base);
  } catch {
    return false;
  }
  if (u.pathname.split('/').some((seg) => seg && idLikeSegment(seg))) return true;
  // URLSearchParams values are already decoded.
  for (const [, v] of u.searchParams) if (v && idLikeSegment(v, true)) return true;
  const hash = u.hash.replace(/^#\/?/, '');
  return hash.split('/').some((seg) => seg && idLikeSegment(seg));
}

export interface ScrubReport {
  removed: { what: string; reason: string }[];
}

const redact = redactContactData;

/**
 * Export copy of a pack: approved, non-stale entries without timestamps;
 * flagged strings, personal-looking selectors and notes removed; usage
 * timestamps dropped. Returns what was removed so the user can review it.
 */
export function scrubForExport(pack: SitePack): { pack: SitePack; report: ScrubReport } {
  const removed: ScrubReport['removed'] = [];
  const entries = pack.entries.flatMap((e) => {
    if (e.status === 'stale') {
      removed.push({ what: e.src, reason: '已过期' });
      return [];
    }
    const flags = textFlags(e.src).filter((f) => f !== 'identifier' && f !== 'number');
    const outFlags = textFlags(e.t).filter((f) => f === 'email' || f === 'url' || f === 'phone' || f === 'handle');
    if (flags.length || outFlags.length) {
      removed.push({ what: e.src, reason: [...flags, ...outFlags].map((f) => FLAG_LABELS[f]).join('、') });
      return [];
    }
    const { approvedAt: _a, lastSeen: _l, where, ...rest } = e;
    // Structure labels travel only if none of them looks personal.
    const labels = where ? [where.surface?.replace(/^\w+: /, ''), where.section, where.group].filter((x): x is string => !!x) : [];
    const badLabel = labels.find((l) => textFlags(l).some((f) => f !== 'identifier'));
    if (badLabel !== undefined) removed.push({ what: `${e.src} 的位置信息`, reason: '含个人信息' });
    return [where && badLabel === undefined ? { ...rest, where } : rest];
  });
  const personalSelector = (sel: string) =>
    [...sel.matchAll(/["']([^"']*)["']/g)].some((m) => textFlags(m[1]!).some((f) => HARD_FLAGS.has(f) || f === 'possible-name') || idLikeSegment(m[1]!));
  const regions = pack.regions.filter((r) => {
    if (!r.selector) return true;
    const bad = personalSelector(r.selector) || textFlags(r.label).some((f) => HARD_FLAGS.has(f));
    if (bad) removed.push({ what: `区域 ${r.label}`, reason: '选择器含个人信息或 ID' });
    return !bad;
  }).map((r) => ({ id: r.id, label: redact(r.label) || (r.builtin ? '弹出菜单 / 对话框 / 提示' : '区域'), ...(r.selector ? { selector: r.selector } : {}), ...(r.builtin ? { builtin: r.builtin } : {}) }));
  const excludes = pack.excludes.filter((sel) => {
    const bad = personalSelector(sel);
    if (bad) removed.push({ what: '一个排除区域', reason: '选择器含个人信息或 ID' });
    return !bad;
  });
  // Context membership only for strings that are exported; surfaces without personal labels.
  const kept = new Set(entries.map((e) => `${e.kind}\u0001${e.src}`));
  const contexts: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(pack.contexts ?? {})) if (kept.has(k)) contexts[k] = [...v];
  const surfaces = (pack.surfaces ?? []).map((sf) =>
    sf.label && textFlags(sf.label).some((f) => f !== 'identifier') ? { key: sf.key, kind: sf.kind } : { key: sf.key, kind: sf.kind, ...(sf.label ? { label: sf.label } : {}) },
  );
  const glossary = pack.glossary.flatMap((g) => {
    const bad = [g.src, g.tgt].some((x) => textFlags(x).some((f) => HARD_FLAGS.has(f) || f === 'possible-name' || f === 'names'));
    if (bad) {
      removed.push({ what: `术语：${g.src}`, reason: '含个人信息' });
      return [];
    }
    if (!g.note) return [g];
    const note = redact(g.note);
    if (note !== g.note) removed.push({ what: `术语备注：${g.src}`, reason: '含联系方式' });
    return [note ? { ...g, note } : { src: g.src, tgt: g.tgt }];
  });
  const description = redact(pack.site.description);
  if (description !== pack.site.description) removed.push({ what: '应用描述', reason: '含联系方式（已删去）' });
  // Rebuilt field by field: nothing is carried over that was not checked above.
  const clean: SitePack = {
      format: pack.format,
      version: pack.version,
      id: pack.id,
      site: { hosts: [...pack.site.hosts], scopes: [...pack.site.scopes], name: redact(pack.site.name) || pack.site.hosts[0]!, description },
      regions,
      sourceLang: pack.sourceLang,
      targetLang: pack.targetLang,
      glossary,
      entries,
      excludes,
      surfaces,
      contexts,
      options: { hydration: pack.options.hydration, learn: pack.options.learn, scope: pack.options.scope },
      generator: { model: redact(pack.generator.model), promptVersion: pack.generator.promptVersion, createdAt: 0, updatedAt: 0 },
      rev: 0,
  };
  // Structural identifiers are validated, never redacted into a different matching scope.
  const validated = validatePack(clean);
  if (!validated.ok) throw new Error(validated.errors.join('；'));
  return { pack: validated.pack, report: { removed } };
}
