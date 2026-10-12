import type { Expert, SiteRule } from './types';

const escapeRe = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

function globToRegExp(glob: string): RegExp {
  return new RegExp('^' + escapeRe(glob).replace(/\*/g, '.*') + '$', 'i');
}

/**
 * Host-only pattern match. `github.com` also matches subdomains,
 * `*.edu` matches any .edu host, `docs.*` matches any host starting with docs.
 */
export function matchHost(pattern: string, host: string): boolean {
  const p = pattern.trim().toLowerCase();
  const h = host.toLowerCase();
  if (!p) return false;
  if (!p.includes('*')) return h === p || h.endsWith('.' + p);
  if (p.startsWith('*.') && !p.slice(2).includes('*')) {
    const base = p.slice(2);
    return h === base || h.endsWith('.' + base);
  }
  return globToRegExp(p).test(h);
}

/** Pattern with a `/` is matched against host+path, otherwise against host. */
export function matchPattern(pattern: string, host: string, path: string): boolean {
  if (pattern.includes('/')) return globToRegExp(pattern.trim()).test(host + path);
  return matchHost(pattern, host);
}

/**
 * Pick the expert for a URL. Path patterns (e.g. `*\/terms*`) beat host
 * patterns so a ToS page on github.com still gets the rigorous expert.
 */
export function resolveExpert(experts: Expert[], url: string, fallbackId: string): Expert | undefined {
  let host = '';
  let path = '/';
  try {
    const u = new URL(url);
    host = u.hostname;
    path = u.pathname;
  } catch {
    // keep defaults
  }
  let best: Expert | undefined;
  let bestScore = 0;
  for (const e of experts) {
    for (const m of e.matches) {
      if (!matchPattern(m, host, path)) continue;
      const score = m.includes('/') ? 2 : 1;
      if (score > bestScore) {
        best = e;
        bestScore = score;
      }
    }
  }
  return best ?? experts.find((e) => e.id === fallbackId);
}

export function findSiteRule(rules: SiteRule[], host: string): SiteRule | undefined {
  return rules.find((r) => r.host && matchHost(r.host, host));
}

export interface ExpertChoice {
  expert: Expert;
  /** Human-readable reason, e.g. "路径匹配 *\/*terms*". */
  reason: string;
}

/** Same resolution as the background (minus the preprocess guess), plus why. */
export function explainExpert(experts: Expert[], url: string, siteRules: SiteRule[], fallbackId: string): ExpertChoice | undefined {
  let host = '';
  let path = '/';
  try {
    const u = new URL(url);
    host = u.hostname;
    path = u.pathname;
  } catch {
    // keep defaults
  }
  const site = findSiteRule(siteRules, host);
  const pinned = site?.expertId && experts.find((e) => e.id === site.expertId);
  if (pinned) return { expert: pinned, reason: `站点规则 ${site!.host}` };
  let best: ExpertChoice | undefined;
  let bestScore = 0;
  for (const e of experts) {
    for (const m of e.matches) {
      if (!matchPattern(m, host, path)) continue;
      const score = m.includes('/') ? 2 : 1;
      if (score > bestScore) {
        best = { expert: e, reason: `${score === 2 ? '路径' : '域名'}匹配 ${m}` };
        bestScore = score;
      }
    }
  }
  if (best) return best;
  const fb = experts.find((e) => e.id === fallbackId);
  return fb ? { expert: fb, reason: '未匹配，使用默认' } : undefined;
}
