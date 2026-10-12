// Site language pack format, v2 (v1 files are upgraded on import). This file is the contract: types, key
// normalization, strict validation (imports and generated output alike),
// merging and the lean runtime form the content script reads.
//
// Dependency-free on purpose (except the tiny hardflags module): it is bundled into the document_start pack script.
import { hasContactData, redactContactData, selectorLooksPersonal } from './hardflags';

export const PACK_FORMAT = 'translucid-site-pack';
export const PACK_VERSION = 2;

export const ENTRY_KINDS = ['text', 'placeholder', 'aria-label', 'aria-description', 'title', 'alt', 'value'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];
/** Attribute kinds; `text` and `value` are handled separately. */
export const ATTR_KINDS = ['placeholder', 'aria-label', 'aria-description', 'title', 'alt'] as const;

export type EntryStatus = 'auto' | 'edited' | 'stale';
export type HydrationMode = 'after-idle' | 'immediate';

export interface PackRegion {
  id: string;
  label: string;
  /** CSS selector of an approved UI area. */
  selector?: string;
  /** Generic overlay class: menus, dialogs, tooltips, listboxes (often portalled to <body>). */
  builtin?: 'overlays';
}

export interface PackEntry {
  kind: EntryKind;
  src: string;
  t: string;
  region?: string;
  status: EntryStatus;
  approvedAt?: number;
  lastSeen?: number;
  /** Context signature (structure.signatures) when this translation applies to one place only ("Medium" width vs size). */
  ctx?: string;
  /** Where the string appeared (source-language labels of approved UI only), for review screens. */
  where?: EntryWhere;
}

export interface EntryWhere {
  surface?: string;
  section?: string;
  group?: string;
  /** Kind of group (radiogroup, select, menu…): options answer the group's question. */
  groupRole?: string;
  role?: string;
}

/** A UI surface learned from scans (dialog, menu …), matched by kind + source label. */
export interface SurfaceDef {
  key: string;
  kind: string;
  label?: string;
}

export type ScopeMode = 'auto' | 'regions';

export interface PackGlossaryEntry {
  src: string;
  tgt: string;
  note?: string;
}

export interface SitePack {
  format: typeof PACK_FORMAT;
  version: typeof PACK_VERSION;
  id: string;
  /** Local store identity; never accepted from an imported pack or exported. */
  lifecycleId?: string;
  site: { hosts: string[]; scopes: string[]; name: string; description: string };
  regions: PackRegion[];
  sourceLang: string;
  targetLang: string;
  glossary: PackGlossaryEntry[];
  entries: PackEntry[];
  excludes: string[];
  /** Surfaces learned from scans. */
  surfaces: SurfaceDef[];
  /** entryKey → every context signature the string was seen in (kept even when translations are shared). */
  contexts: Record<string, string[]>;
  /** learn: record new UI strings during normal use; scope: automatic classification or approved regions only. */
  options: { hydration: HydrationMode; learn: boolean; scope: ScopeMode };
  generator: { model: string; promptVersion: number; createdAt: number; updatedAt: number };
  rev: number;
}

/** Small list read at document_start to decide whether a page has a pack. */
export interface PackIndexItem {
  id: string;
  hosts: string[];
  scopes: string[];
  targetLang: string;
  enabled: boolean;
  entries: number;
  updatedAt: number;
}

/** Lean form for the applier: key → translation. */
export interface PackRuntime {
  id: string;
  rev: number;
  targetLang: string;
  /** `entryKey(kind, src)` → translation. Keys always contain U+0001, so they never collide with prototype names. */
  map: Record<string, string>;
  excludes: string[];
  hydration: HydrationMode;
  /** Approved regions (forced includes; the only scope when scope = 'regions'). */
  regions: PackRegion[];
  /** key → signature → translation, for strings whose translation depends on context. */
  ctx?: Record<string, Record<string, string>>;
  /** Keys that only have context variants: in an unseen context they stay untranslated (and are reported). */
  ambiguous?: string[];
  learn?: boolean;
  scope?: ScopeMode;
}

export const LIMITS = {
  entries: 5000,
  keyChars: 120,
  fileBytes: 2 * 1024 * 1024,
  hosts: 20,
  scopes: 20,
  regions: 50,
  excludes: 50,
  glossary: 500,
  glossaryChars: 200,
  descriptionChars: 1000,
  surfaces: 100,
  variantsPerKey: 8,
  contextsPerKey: 16,
  whereChars: 80,
};

export const CTX_RE = /^[gs]:[0-9a-z]{4,8}$/;
const VARIANT_SEP = '\u0002';
/** Identity of one stored entry: string key plus optional context. */
export const variantKey = (kind: EntryKind, src: string, ctx?: string) => entryKey(kind, src) + (ctx ? VARIANT_SEP + ctx : '');

const KEY_SEP = '\u0001';
// Only invisible noise is dropped; ZWJ/ZWNJ (U+200D/U+200C) and NBSP carry meaning in some scripts.
const INVISIBLE_RE = /[​﻿]/g;
const ASCII_SPACE_RE = /[ \t\n\r\f]+/g;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const BIDI_RE = /[‪-‮⁦-⁩]/g;
const MARKUP_RE = /<[A-Za-z!/?]/;

/** Matching form of a UI string: NFC, invisible noise removed, ASCII whitespace collapsed, trimmed. */
export function normalizeKey(s: string): string {
  return s.normalize('NFC').replace(INVISIBLE_RE, '').replace(ASCII_SPACE_RE, ' ').trim();
}

export function entryKey(kind: EntryKind, src: string): string {
  return kind + KEY_SEP + normalizeKey(src);
}

/** Remove control and bidi-override characters (spoofing vectors in imported files). */
export function sanitizeText(s: string): string {
  return s.replace(CONTROL_RE, '').replace(BIDI_RE, '');
}

export function hasMarkup(s: string): boolean {
  return MARKUP_RE.test(s);
}

const PLACEHOLDER_RE = /\{\{[^{}]{1,40}\}\}|\{[A-Za-z0-9_]{1,40}\}|%(?:\d+\$)?[sdif@]|\$\{[A-Za-z0-9_]{1,40}\}/g;

/** Placeholder tokens as a sorted multiset ({0}, {name}, {{x}}, %s, %1$d, ${x}). */
export function placeholders(s: string): string[] {
  return (s.match(PLACEHOLDER_RE) ?? []).sort();
}

export function samePlaceholders(a: string, b: string): boolean {
  const x = placeholders(a);
  const y = placeholders(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

export function isValidHost(h: string): boolean {
  if (h === 'localhost') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  return /^(?=.{1,253}$)(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(h);
}

export function isValidLang(code: string): boolean {
  if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(code)) return false;
  try {
    return Intl.getCanonicalLocales(code).length === 1;
  } catch {
    return false;
  }
}

export function packId(host: string, targetLang: string): string {
  return `${host.toLowerCase()}~${targetLang}`;
}

export function emptyPack(host: string, targetLang: string, now = Date.now()): SitePack {
  return {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    id: packId(host, targetLang),
    site: { hosts: [host.toLowerCase()], scopes: ['/'], name: host, description: '' },
    regions: [],
    sourceLang: 'auto',
    targetLang,
    glossary: [],
    entries: [],
    excludes: [],
    surfaces: [],
    contexts: Object.create(null),
    options: { hydration: 'after-idle', learn: true, scope: 'auto' },
    generator: { model: '', promptVersion: 0, createdAt: now, updatedAt: now },
    rev: 0,
  };
}

/**
 * Why a translation is unacceptable for its source, or undefined if it is fine.
 * Shared by import validation and generated output.
 */
export function translationProblem(src: string, t: string): string | undefined {
  if (!t.trim()) return 'empty';
  if (/[\r\n]/.test(t)) return 'multi-line';
  if (hasMarkup(t)) return 'markup';
  if (t.length > src.length * 4 + 20) return 'too long';
  if (!samePlaceholders(src, t)) return 'placeholders differ';
  return undefined;
}

type SelectorCheck = (sel: string) => boolean;

/** CSS selector syntax check; uses the DOM when available, else a conservative character check. */
export function defaultSelectorCheck(sel: string): boolean {
  if (!sel || sel.length > 300) return false;
  const doc = (globalThis as { document?: Document }).document;
  if (doc) {
    try {
      doc.createDocumentFragment().querySelector(sel);
      return true;
    } catch {
      return false;
    }
  }
  return /^[^{};<>]+$/.test(sel);
}

const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' ? sanitizeText(v).slice(0, max) : undefined;
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export type ValidateResult = { ok: true; pack: SitePack; warnings: string[] } | { ok: false; errors: string[] };

/**
 * Strict structural validation. Rebuilds the pack from known fields only, so
 * unknown fields (and prototype tricks) never survive.
 */
export function validatePack(raw: unknown, isSelector: SelectorCheck = defaultSelectorCheck): ValidateResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const r = raw as Record<string, any> | null;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, errors: ['不是 JSON 对象'] };
  if (r.format !== PACK_FORMAT) errors.push(`format 应为 ${PACK_FORMAT}`);
  if (r.version !== 1 && r.version !== PACK_VERSION) errors.push(`不支持的 version：${String(r.version)}`);
  const v1 = r.version === 1;

  const site = (r.site ?? {}) as Record<string, any>;
  const hosts = (Array.isArray(site.hosts) ? site.hosts : [])
    .map((h: unknown) => (typeof h === 'string' ? h.trim().toLowerCase() : ''))
    .filter((h: string) => {
      if (isValidHost(h)) return true;
      if (h) warnings.push(`已忽略无效域名：${h}`);
      return false;
    })
    .slice(0, LIMITS.hosts);
  if (!hosts.length) errors.push('site.hosts 至少需要一个有效域名');
  const rawScopes: unknown[] = Array.isArray(site.scopes) ? site.scopes : ['/'];
  const scopes = rawScopes
    .filter((s: unknown): s is string => typeof s === 'string' && s.startsWith('/') && s.length <= 200)
    .slice(0, LIMITS.scopes);

  if (rawScopes.some((value) => {
    if (typeof value !== 'string') return false;
    const scope = value;
    try { return hasContactData(scope) || hasContactData(decodeURIComponent(scope)); } catch { return hasContactData(scope); }
  })) errors.push('路径范围含邮箱、网址、电话或 @用户名，请先移除这些个人信息');

  const targetLang = typeof r.targetLang === 'string' ? r.targetLang : '';
  if (!isValidLang(targetLang)) errors.push(`无效的 targetLang：${targetLang}`);
  const sourceLang = typeof r.sourceLang === 'string' && (r.sourceLang === 'auto' || isValidLang(r.sourceLang)) ? r.sourceLang : 'auto';

  const regions: PackRegion[] = [];
  for (const g of Array.isArray(r.regions) ? r.regions.slice(0, LIMITS.regions) : []) {
    const id = str(g?.id, 40);
    if (!id) continue;
    if (typeof g.id === 'string' && hasContactData(g.id)) { warnings.push('已忽略含联系方式的区域标识'); continue; }
    if (g.builtin === 'overlays') {
      regions.push({ id, label: redactContactData(str(g.label, 80) ?? '') || '弹出菜单 / 对话框 / 提示', builtin: 'overlays' });
    } else if (typeof g.selector === 'string' && isSelector(g.selector) && !selectorLooksPersonal(g.selector)) {
      const label = str(g.label, 80);
      regions.push({ id, label: label && !hasContactData(label) ? label : id, selector: g.selector });
    } else {
      warnings.push(`已忽略无效区域：${id}`);
    }
  }

  const byKey = new Map<string, PackEntry>();
  const list = Array.isArray(r.entries) ? r.entries : [];
  if (list.length > LIMITS.entries) errors.push(`条目超过上限 ${LIMITS.entries}`);
  for (const e of list.slice(0, LIMITS.entries)) {
    const kind = e?.kind as EntryKind;
    if (!ENTRY_KINDS.includes(kind)) {
      warnings.push(`已忽略未知类型：${String(e?.kind)}`);
      continue;
    }
    const src = typeof e.src === 'string' ? normalizeKey(sanitizeText(e.src)) : '';
    const t = typeof e.t === 'string' ? sanitizeText(e.t).trim() : '';
    if (!src || src.length > LIMITS.keyChars) {
      warnings.push(`已忽略过长或为空的原文：${src.slice(0, 40)}`);
      continue;
    }
    const problem = translationProblem(src, t);
    if (problem) {
      warnings.push(`已忽略「${src.slice(0, 40)}」：${problem}`);
      continue;
    }
    // Contact data is never interface text, whatever the source of the file.
    if (hasContactData(src) || hasContactData(t)) {
      warnings.push('已忽略一条含邮箱、网址、电话或 @用户名的条目');
      continue;
    }
    const status: EntryStatus = e.status === 'edited' || e.status === 'stale' ? e.status : 'auto';
    const entry: PackEntry = { kind, src, t, status };
    const region = str(e.region, 40);
    if (typeof e.region === 'string' && hasContactData(e.region)) { warnings.push('已忽略含联系方式的区域引用'); continue; }
    if (region) entry.region = region;
    const approvedAt = num(e.approvedAt);
    if (approvedAt !== undefined) entry.approvedAt = approvedAt;
    const lastSeen = num(e.lastSeen);
    if (lastSeen !== undefined) entry.lastSeen = lastSeen;
    if (e.ctx !== undefined) {
      if (typeof e.ctx !== 'string' || !CTX_RE.test(e.ctx)) {
        warnings.push(`已忽略「${src.slice(0, 40)}」：无效的语境标识`);
        continue;
      }
      entry.ctx = e.ctx;
    }
    const where = sanitizeWhere(e.where);
    if (where) entry.where = where;
    const key = variantKey(kind, src, entry.ctx);
    const prev = byKey.get(key);
    // Duplicates after normalization: an edited entry wins, otherwise the first one.
    if (!prev || (prev.status !== 'edited' && status === 'edited')) byKey.set(key, entry);
  }
  // At most N context variants per string.
  const perKey = new Map<string, number>();
  for (const [k, e] of [...byKey]) {
    if (!e.ctx) continue;
    const base = entryKey(e.kind, e.src);
    const n = (perKey.get(base) ?? 0) + 1;
    perKey.set(base, n);
    if (n > LIMITS.variantsPerKey) {
      byKey.delete(k);
      warnings.push(`「${e.src.slice(0, 40)}」的语境变体过多，已截断`);
    }
  }

  const contexts: Record<string, string[]> = Object.create(null);
  const keptKeys = new Set([...byKey.values()].map((e) => entryKey(e.kind, e.src)));
  if (r.contexts && typeof r.contexts === 'object' && !Array.isArray(r.contexts)) {
    for (const [k, list] of Object.entries(r.contexts as Record<string, unknown>).slice(0, LIMITS.entries)) {
      // Membership only for strings the pack actually holds (no orphaned keys carrying old text).
      if (typeof k !== 'string' || !keptKeys.has(k) || !Array.isArray(list)) continue;
      const sigs = [...new Set(list.filter((x): x is string => typeof x === 'string' && CTX_RE.test(x)))].slice(0, LIMITS.contextsPerKey);
      if (sigs.length) contexts[k] = sigs;
    }
  }
  const surfaces: SurfaceDef[] = [];
  for (const sf of Array.isArray(r.surfaces) ? r.surfaces.slice(0, LIMITS.surfaces) : []) {
    const key = str(sf?.key, 60);
    const kind = str(sf?.kind, 20);
    if (!key || !kind || hasContactData(key) || !/^(page|dialog|menu|popover|listbox|drawer)$/.test(kind)) continue;
    const label = str(sf.label, LIMITS.whereChars)?.trim();
    surfaces.push(label && !hasMarkup(label) && !hasContactData(label) ? { key, kind, label } : { key, kind });
  }

  const glossary: PackGlossaryEntry[] = [];
  for (const g of Array.isArray(r.glossary) ? r.glossary.slice(0, LIMITS.glossary) : []) {
    const src = str(g?.src, LIMITS.glossaryChars)?.trim();
    const tgt = str(g?.tgt, LIMITS.glossaryChars)?.trim();
    if (!src || !tgt || hasMarkup(tgt) || hasContactData(src) || hasContactData(tgt)) continue;
    const note = redactContactData(str(g.note, LIMITS.glossaryChars) ?? '');
    glossary.push(note ? { src, tgt, note } : { src, tgt });
  }

  const excludes = (Array.isArray(r.excludes) ? r.excludes : [])
    .filter((s: unknown): s is string => typeof s === 'string' && isSelector(s) && !selectorLooksPersonal(s))
    .slice(0, LIMITS.excludes);

  if (errors.length) return { ok: false, errors };
  const gen = (r.generator ?? {}) as Record<string, unknown>;
  const now = Date.now();
  const pack: SitePack = {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    id: packId(hosts[0]!, targetLang),
    site: {
      hosts,
      scopes: scopes.length ? scopes : ['/'],
      name: redactContactData(str(site.name, 80) ?? '') || hosts[0]!,
      description: redactContactData(str(site.description, LIMITS.descriptionChars) ?? ''),
    },
    regions,
    sourceLang,
    targetLang,
    glossary,
    entries: [...byKey.values()],
    excludes,
    surfaces,
    contexts,
    // v1 packs keep the scope the user authorized (approved regions, no background learning).
    options: {
      hydration: r.options?.hydration === 'immediate' ? 'immediate' : 'after-idle',
      learn: v1 ? false : r.options?.learn !== false,
      scope: v1 ? 'regions' : r.options?.scope === 'regions' ? 'regions' : 'auto',
    },
    generator: {
      model: redactContactData(str(gen.model, 80) ?? ''),
      promptVersion: num(gen.promptVersion) ?? 0,
      createdAt: num(gen.createdAt) ?? now,
      updatedAt: num(gen.updatedAt) ?? now,
    },
    rev: Math.max(0, Math.floor(num(r.rev) ?? 0)),
  };
  return { ok: true, pack, warnings };
}

/** Structure labels on an entry: plain text, bounded, no markup. */
export function sanitizeWhere(raw: unknown): EntryWhere | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const w = raw as Record<string, unknown>;
  const out: EntryWhere = {};
  for (const f of ['surface', 'section', 'group', 'groupRole', 'role'] as const) {
    const v = str(w[f], LIMITS.whereChars)?.trim();
    if (v && !hasMarkup(v) && !hasContactData(v)) out[f] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Parse an imported file: size cap, JSON, then strict validation. */
export function parsePackFile(text: string, isSelector?: SelectorCheck): ValidateResult {
  if (new Blob([text]).size > LIMITS.fileBytes) return { ok: false, errors: ['文件超过 2 MB'] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['不是有效的 JSON'] };
  }
  return validatePack(raw, isSelector);
}

export interface MergeResult {
  pack: SitePack;
  added: number;
  updated: number;
  skippedEdited: number;
}

/** Merge generated or imported entries; user-edited entries are never overwritten. */
export function mergeEntries(pack: SitePack, incoming: PackEntry[], now = Date.now()): MergeResult {
  const map = new Map(pack.entries.map((e) => [variantKey(e.kind, e.src, e.ctx), e]));
  let added = 0;
  let updated = 0;
  let skippedEdited = 0;
  for (const e of incoming) {
    const key = variantKey(e.kind, e.src, e.ctx);
    const prev = map.get(key);
    if (prev?.status === 'edited' && e.status !== 'edited') {
      skippedEdited++;
      continue;
    }
    if (prev) updated++;
    else added++;
    map.set(key, { ...e, src: normalizeKey(e.src) });
  }
  const entries = [...map.values()].slice(0, LIMITS.entries);
  return { pack: { ...pack, entries, generator: { ...pack.generator, updatedAt: now } }, added, updated, skippedEdited };
}

/** Entries not seen for `days` become stale (still applied, flagged for cleanup). */
export function markStale(pack: SitePack, now = Date.now(), days = 60): SitePack {
  const cutoff = now - days * 86_400_000;
  return {
    ...pack,
    entries: pack.entries.map((e) =>
      e.status === 'auto' && e.lastSeen !== undefined && e.lastSeen < cutoff ? { ...e, status: 'stale' as const } : e,
    ),
  };
}

export function toRuntime(pack: SitePack): PackRuntime {
  const map: Record<string, string> = Object.create(null);
  const ctx: Record<string, Record<string, string>> = Object.create(null);
  for (const e of pack.entries) {
    const key = entryKey(e.kind, e.src);
    if (e.ctx) (ctx[key] ??= Object.create(null))[e.ctx] = e.t;
    else map[key] = e.t;
  }
  const ambiguous = Object.keys(ctx).filter((k) => !Object.prototype.hasOwnProperty.call(map, k));
  return {
    id: pack.id,
    rev: pack.rev,
    targetLang: pack.targetLang,
    map,
    ...(Object.keys(ctx).length ? { ctx, ambiguous } : {}),
    excludes: pack.excludes,
    hydration: pack.options.hydration,
    regions: pack.regions,
    learn: pack.options.learn,
    scope: pack.options.scope,
  };
}

export interface ContextualResult {
  kind: EntryKind;
  src: string;
  t: string;
  ctx?: string;
  where?: EntryWhere;
  region?: string;
}

/**
 * Merge translations that came with context signatures. Per string: if every
 * known context agrees, keep one shared entry (no ctx) and remember the contexts;
 * if they differ, store per-context variants. User-edited entries are never
 * overwritten; a legacy shared entry without known contexts stays as fallback.
 */
export function mergeContextual(pack: SitePack, results: ContextualResult[], now = Date.now()): SitePack {
  const contexts: Record<string, string[]> = Object.assign(Object.create(null), pack.contexts);
  let entries = [...pack.entries];
  const byKey = new Map<string, ContextualResult[]>();
  for (const r of results) {
    const k = entryKey(r.kind, normalizeKey(r.src));
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  for (const [key, list] of byKey) {
    const first = list[0]!;
    const src = normalizeKey(first.src);
    const same = (e: PackEntry) => entryKey(e.kind, e.src) === key;
    const generic = entries.find((e) => same(e) && !e.ctx);
    const variants = entries.filter((e) => same(e) && e.ctx);
    const members = new Set(contexts[key] ?? []);
    const base = { kind: first.kind, src, status: 'auto' as const, approvedAt: now, lastSeen: now, ...(first.region ? { region: first.region } : {}) };
    // What each known context will show after this merge (edited entries always win).
    const eff = new Map<string, { t: string; edited: boolean; where?: EntryWhere }>();
    for (const v of variants) eff.set(v.ctx!, { t: v.t, edited: v.status === 'edited', ...(v.where ? { where: v.where } : {}) });
    if (generic && members.size) {
      for (const c of members) if (!eff.has(c)) eff.set(c, { t: generic.t, edited: generic.status === 'edited', ...(generic.where ? { where: generic.where } : {}) });
    }
    let unknownCtx: string | undefined; // a translation for "wherever" (approved regions, v1 flows)
    for (const r of list) {
      if (!r.ctx) {
        if (generic?.status !== 'edited') unknownCtx = r.t;
        continue;
      }
      const prev = eff.get(r.ctx);
      if (prev?.edited) continue;
      const where = r.where ?? prev?.where;
      eff.set(r.ctx, { t: r.t, edited: false, ...(where ? { where } : {}) });
    }
    const finals = new Set([...eff.values()].map((e) => e.t));
    if (unknownCtx !== undefined) finals.add(unknownCtx);
    if (finals.size === 0) continue; // nothing changes (everything here was edited by the user)
    // Rebuild this string's entries; the user's edits stay exactly as they are.
    entries = entries.filter((e) => !same(e) || e.status === 'edited');
    const where = first.where ?? generic?.where;
    if (finals.size === 1) {
      // Every place agrees: one shared entry (unless the user's edited one already says it).
      const t = [...finals][0]!;
      if (generic?.status !== 'edited') entries.push({ ...base, t, ...(where ? { where } : {}) });
    } else {
      // Places disagree: one entry per context. A shared entry with known places is replaced by
      // their variants; one without known places (or the user's) stays as the fallback.
      if (generic && generic.status !== 'edited') {
        if (unknownCtx !== undefined) entries.push({ ...base, t: unknownCtx, ...(where ? { where } : {}) });
        else if (!members.size) entries.push(generic);
      } else if (!generic && unknownCtx !== undefined) {
        entries.push({ ...base, t: unknownCtx, ...(where ? { where } : {}) });
      }
      for (const [c, e] of eff) {
        if (e.edited) continue;
        entries.push({ ...base, t: e.t, ctx: c, ...(e.where ? { where: e.where } : {}) });
      }
    }
    for (const r of list) if (r.ctx) members.add(r.ctx);
    if (members.size) contexts[key] = [...members].slice(-LIMITS.contextsPerKey);
  }
  return { ...pack, entries: entries.slice(0, LIMITS.entries), contexts, generator: { ...pack.generator, updatedAt: now } };
}

export function toIndexItem(pack: SitePack, enabled: boolean): PackIndexItem {
  return {
    id: pack.id,
    hosts: pack.site.hosts,
    scopes: pack.site.scopes,
    targetLang: pack.targetLang,
    enabled,
    entries: pack.entries.length,
    updatedAt: pack.generator.updatedAt,
  };
}

/** Length of the longest scope prefix matching `path`, or -1. */
export function scopeMatch(scopes: string[], path: string): number {
  let best = -1;
  for (const s of scopes) {
    const ok = s === '/' || path === s || path.startsWith(s.endsWith('/') ? s : s + '/');
    if (ok && s.length > best) best = s.length;
  }
  return best;
}

/**
 * The single active pack for a page: enabled, exact host, most specific scope,
 * then most recently updated. One target language per host+scope at a time.
 */
export function selectPack(index: PackIndexItem[], host: string, path: string): PackIndexItem | undefined {
  let best: { item: PackIndexItem; score: number } | undefined;
  for (const item of index) {
    if (!item.enabled || !item.hosts.includes(host.toLowerCase())) continue;
    const score = scopeMatch(item.scopes, path);
    if (score < 0) continue;
    if (!best || score > best.score || (score === best.score && item.updatedAt > best.item.updatedAt)) best = { item, score };
  }
  return best?.item;
}

const own = (o: object | undefined, k: string) => !!o && Object.prototype.hasOwnProperty.call(o, k);

/** Lookup without trusting the map's prototype (storage round-trips return plain objects). */
export function lookup(rt: PackRuntime, kind: EntryKind, src: string): string | undefined {
  const key = entryKey(kind, src);
  return own(rt.map, key) ? rt.map[key] : undefined;
}

/** Does this string's translation depend on where it appears? */
export function hasVariants(rt: PackRuntime, kind: EntryKind, src: string): boolean {
  return own(rt.ctx, entryKey(kind, src));
}

/**
 * Context-aware lookup. `sigs` (most specific first) is only computed for keys
 * with variants. Returns the translation, undefined when unknown, or null when the
 * string is known only in other contexts (leave it untranslated, report it).
 */
export function resolve(rt: PackRuntime, kind: EntryKind, src: string, sigs: () => string[]): string | undefined | null {
  const key = entryKey(kind, src);
  const variants = own(rt.ctx, key) ? rt.ctx![key]! : undefined;
  if (variants) {
    for (const s of sigs()) if (own(variants, s)) return variants[s]!;
    if (own(rt.map, key)) return rt.map[key];
    return null;
  }
  return own(rt.map, key) ? rt.map[key] : undefined;
}
