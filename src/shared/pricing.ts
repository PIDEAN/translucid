import type { PriceOverride, ProviderConfig, ProviderVendor } from './types';

// Official list prices per 1M tokens, checked 2026-10-03:
// - DeepSeek: api-docs.deepseek.com/quick_start/pricing (USD) and /zh-cn/ (CNY)
// - Gemini: ai.google.dev/gemini-api/docs/pricing (updated 2026-10-01)
// - Zhipu: docs.z.ai pricing (USD); bigmodel.cn free models (CNY)
// - OpenCode Zen: opencode.ai/docs/zen ; Go: opencode.ai/docs/go (subscription)
// - OpenRouter (checked 2026-10-04): openrouter.ai/openrouter/free and /docs/guides/routing/model-variants/free
// - NVIDIA hosted trial (checked 2026-10-04): build.nvidia.com/nvidia/nemotron-3-super-120b-a12b
// - Anthropic (checked 2026-10-11): platform.claude.com/docs/en/about-claude/pricing
// These are defaults only; any field can be overridden per provider in Options.

export interface Rates {
  input: number;
  cacheHit: number;
  output: number;
}

export interface PriceSpec extends Rates {
  currency: '¥' | '$';
  /** Off-peak rates; present when the vendor has time-of-day pricing. */
  offPeak?: Rates;
  /** Subscription plan: tokens are not billed, rates are the pay-as-you-go equivalent. */
  subscription?: { fee: string; note: string };
  /** Rate for tokens written to the prompt cache (Anthropic bills 1.25× input); absent = billed as input. */
  cacheWrite?: number;
  /** Shown next to the price, e.g. a long-context rate card. */
  note?: string;
}

const DEEPSEEK: Record<'cn' | 'global', Record<string, PriceSpec>> = {
  cn: {
    'deepseek-flash': { input: 2, cacheHit: 0.04, output: 8, currency: '¥', offPeak: { input: 1, cacheHit: 0.02, output: 4 } },
    'deepseek-v4-pro': { input: 9, cacheHit: 0.3, output: 27, currency: '¥', offPeak: { input: 4.5, cacheHit: 0.15, output: 13.5 } },
  },
  global: {
    'deepseek-flash': { input: 0.3, cacheHit: 0.006, output: 1.2, currency: '$', offPeak: { input: 0.15, cacheHit: 0.003, output: 0.6 } },
    'deepseek-v4-pro': { input: 1.32, cacheHit: 0.044, output: 3.96, currency: '$', offPeak: { input: 0.66, cacheHit: 0.022, output: 1.98 } },
  },
};

const GEMINI: Record<string, PriceSpec> = {
  'gemini-3.1-flash-lite': { input: 0.25, cacheHit: 0.025, output: 1.5, currency: '$' },
  'gemini-3.5-flash-lite': { input: 0.3, cacheHit: 0.03, output: 2.5, currency: '$' },
  // Promotional through 2026-12-31; doubles on 2027-01-01.
  'gemini-3.8-flash': { input: 0.75, cacheHit: 0.075, output: 3.75, currency: '$' },
};

const GLM_GLOBAL: Record<string, PriceSpec> = {
  'glm-4.7-flash': { input: 0, cacheHit: 0, output: 0, currency: '$' },
  'glm-4.5-flash': { input: 0, cacheHit: 0, output: 0, currency: '$' },
  'glm-4.7-flashx': { input: 0.07, cacheHit: 0, output: 0.4, currency: '$' },
  'glm-5.3-flash': { input: 0.15, cacheHit: 0.03, output: 0.5, currency: '$' },
};

const GLM_CN: Record<string, PriceSpec> = {
  'glm-4.7-flash': { input: 0, cacheHit: 0, output: 0, currency: '¥' },
  'glm-4-flash-250414': { input: 0, cacheHit: 0, output: 0, currency: '¥' },
};

/** Zen pay-as-you-go prices for models on /chat/completions (the only API shape this extension speaks). */
const ZEN: Record<string, PriceSpec> = {
  'deepseek-v4.1-flash': { input: 0.3, cacheHit: 0.006, output: 1.2, currency: '$' },
  'deepseek-v4-flash': { input: 0.14, cacheHit: 0.028, output: 0.28, currency: '$' },
  'deepseek-v4-pro': { input: 1.74, cacheHit: 0.145, output: 3.48, currency: '$' },
  'glm-5.3-flash': { input: 0.15, cacheHit: 0.03, output: 0.5, currency: '$' },
  'glm-5.3': { input: 1.4, cacheHit: 0.26, output: 4.4, currency: '$' },
  'kimi-k2.6': { input: 0.95, cacheHit: 0.16, output: 4, currency: '$' },
  'minimax-m3': { input: 0.3, cacheHit: 0.06, output: 1.2, currency: '$' },
  'qwen3.8-max': { input: 2, cacheHit: 0.25, output: 6, currency: '$' },
  'big-pickle': { input: 0, cacheHit: 0, output: 0, currency: '$' },
  'mimo-v2.6-flash-free': { input: 0, cacheHit: 0, output: 0, currency: '$' },
  'ling-3.1-flash-free': { input: 0, cacheHit: 0, output: 0, currency: '$' },
};

/**
 * Claude prompts over 100K tokens use a higher card ($0.50/$2.50 for Haiku 5.5);
 * translation batches stay far below that, so only the base card is modeled.
 */
const ANTHROPIC: Record<string, PriceSpec> = {
  'claude-haiku-5-5': { input: 0.1, cacheHit: 0.01, cacheWrite: 0.125, output: 0.5, currency: '$', note: '提示超过 100K tokens 按 $0.50 / $2.50 计费；缓存写入 1.25× 输入价' },
};

const GO_FEE = { fee: '$10/月（Go）· $40/月（Go Plus）', note: '按模型设每月等价美元额度，如 DeepSeek V4 Flash $30/月、GLM-5.3-Flash $60/月；5 小时/每周/每月滚动上限为月额度的 20%/50%/100%' };

/** Models worth suggesting in the model field, per vendor. */
export const MODEL_SUGGESTIONS: Record<ProviderVendor, string[]> = {
  deepseek: Object.keys(DEEPSEEK.global),
  glm: Object.keys(GLM_CN),
  'glm-global': Object.keys(GLM_GLOBAL),
  gemini: Object.keys(GEMINI),
  'opencode-zen': Object.keys(ZEN),
  'opencode-go': ['deepseek-v4.1-flash', 'deepseek-v4-flash', 'deepseek-v4-pro', 'glm-5.3-flash', 'glm-5.3', 'kimi-k2.6', 'mimo-v2.6-flash'],
  openrouter: ['openrouter/free'],
  nvidia: ['nvidia/nemotron-3-super-120b-a12b'],
  anthropic: Object.keys(ANTHROPIC),
  'google-translate': ['gtx'],
  'microsoft-translator': ['edge'],
  custom: [],
};

/** Vendor from an explicit field, else from the base URL (settings saved before vendors existed). */
export function vendorOf(p: Pick<ProviderConfig, 'vendor' | 'baseURL'>): ProviderVendor {
  if (p.vendor) return p.vendor;
  const u = p.baseURL.toLowerCase();
  if (u.includes('deepseek.com')) return 'deepseek';
  if (u.includes('api.anthropic.com')) return 'anthropic';
  if (u.includes('translate.googleapis.com')) return 'google-translate';
  if (u.includes('edge.microsoft.com')) return 'microsoft-translator';
  if (u.includes('openrouter.ai')) return 'openrouter';
  if (u.includes('integrate.api.nvidia.com')) return 'nvidia';
  if (u.includes('opencode.ai/zen/go')) return 'opencode-go';
  if (u.includes('opencode.ai/zen')) return 'opencode-zen';
  if (u.includes('bigmodel.cn')) return 'glm';
  if (u.includes('api.z.ai')) return 'glm-global';
  if (u.includes('generativelanguage.googleapis.com')) return 'gemini';
  return 'custom';
}

/** Free machine translation (no LLM, no key): only for short plain strings such as menus and buttons. */
export function isMachineTranslation(p: Pick<ProviderConfig, 'vendor' | 'baseURL'>): boolean {
  const v = vendorOf(p);
  return v === 'google-translate' || v === 'microsoft-translator';
}

/** Has what it needs to send requests: a key and a model, except keyless machine translation. */
export function providerReady(p: ProviderConfig): boolean {
  return isMachineTranslation(p) || (!!p.apiKey && !!p.model);
}

/** DeepSeek account region: explicit choice, else what /user/balance reported, else CN (the larger user base here). */
export function deepseekRegion(p: Pick<ProviderConfig, 'region' | 'detectedRegion'>): 'cn' | 'global' {
  if (p.region === 'cn' || p.region === 'global') return p.region;
  return p.detectedRegion ?? 'cn';
}

/** Default (catalog) price for the provider's vendor, region and model; undefined for unknown models. */
export function defaultPrice(p: ProviderConfig): PriceSpec | undefined {
  const model = p.model.trim().toLowerCase();
  switch (vendorOf(p)) {
    case 'deepseek':
      return DEEPSEEK[deepseekRegion(p)][model];
    case 'gemini':
      return GEMINI[model];
    case 'glm':
      return GLM_CN[model];
    case 'glm-global':
      return GLM_GLOBAL[model];
    case 'openrouter':
      return model === 'openrouter/free' || model.endsWith(':free')
        ? { input: 0, cacheHit: 0, output: 0, currency: '$' }
        : undefined;
    case 'nvidia':
      return MODEL_SUGGESTIONS.nvidia.includes(model)
        ? { input: 0, cacheHit: 0, output: 0, currency: '$' }
        : undefined;
    case 'anthropic':
      return ANTHROPIC[model];
    case 'google-translate':
    case 'microsoft-translator':
      return { input: 0, cacheHit: 0, output: 0, currency: '$' };
    case 'opencode-zen':
      return ZEN[model];
    case 'opencode-go': {
      const base = ZEN[model];
      return base ? { ...base, subscription: GO_FEE } : { input: 0, cacheHit: 0, output: 0, currency: '$', subscription: GO_FEE };
    }
    default:
      return undefined;
  }
}

/** Default merged with the user's overrides (empty override fields fall back to the default). */
export function resolvedPrice(p: ProviderConfig): PriceSpec {
  const d = defaultPrice(p) ?? { input: 0, cacheHit: 0, output: 0, currency: '$' as const };
  const o: PriceOverride = p.price ?? {};
  const pick = (v: number | undefined, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const spec: PriceSpec = {
    ...d,
    currency: (o.currency as PriceSpec['currency']) || d.currency,
    input: pick(o.input, d.input),
    cacheHit: pick(o.cacheHit, d.cacheHit),
    output: pick(o.output, d.output),
  };
  // Keep the cache-write surcharge proportional when the input price is overridden.
  if (d.cacheWrite != null && d.input > 0) spec.cacheWrite = spec.input * (d.cacheWrite / d.input);
  if (d.offPeak) {
    spec.offPeak = {
      input: pick(o.offInput, d.offPeak.input),
      cacheHit: pick(o.offCacheHit, d.offPeak.cacheHit),
      output: pick(o.offOutput, d.offPeak.output),
    };
  }
  return spec;
}

// ---------- DeepSeek peak / off-peak ----------

/** Peak windows in Beijing time (UTC+8, no DST), Monday–Friday: 09:00–12:00 and 14:00–18:00. */
export const DEEPSEEK_PEAK_WINDOWS: [number, number][] = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
];
const BEIJING_OFFSET_MIN = 8 * 60;

/**
 * Chinese public holidays are off-peak too; they are not modelled, so a holiday
 * counts as peak — estimates err on the expensive side.
 */
export function isDeepSeekPeak(date: Date = new Date()): boolean {
  const bj = new Date(date.getTime() + BEIJING_OFFSET_MIN * 60_000);
  const day = bj.getUTCDay();
  if (day === 0 || day === 6) return false;
  const min = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  return DEEPSEEK_PEAK_WINDOWS.some(([a, b]) => min >= a && min < b);
}

/** Rates in force at `date` (off-peak rates during off-peak hours when the vendor has them). */
export function ratesAt(spec: PriceSpec, date: Date = new Date()): Rates & { period: 'peak' | 'offpeak' | null } {
  if (!spec.offPeak) return { input: spec.input, cacheHit: spec.cacheHit, output: spec.output, period: null };
  return isDeepSeekPeak(date) ? { ...spec, period: 'peak' } : { ...spec.offPeak, period: 'offpeak' };
}

export function costOf(
  usage: { promptTokens: number; cacheHitTokens: number; completionTokens: number; cacheWriteTokens?: number },
  spec: PriceSpec,
  date: Date = new Date(),
): number {
  if (spec.subscription) return 0;
  const r = ratesAt(spec, date);
  const miss = Math.max(0, usage.promptTokens - usage.cacheHitTokens);
  // Cache writes are part of the miss tokens; charge only their surcharge on top.
  const writeExtra = spec.cacheWrite != null ? (usage.cacheWriteTokens ?? 0) * Math.max(0, spec.cacheWrite - r.input) : 0;
  return (miss * r.input + usage.cacheHitTokens * r.cacheHit + usage.completionTokens * r.output + writeExtra) / 1e6;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const hhmm = (m: number) => {
  const x = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
};

/**
 * DeepSeek's peak windows expressed in another time zone, e.g. for UTC-7:
 * "周日至周四 18:00–21:00、23:00–次日 03:00". `offsetMin` is minutes east of UTC.
 */
export function peakWindowsIn(offsetMin: number): string {
  const delta = offsetMin - BEIJING_OFFSET_MIN;
  const parts = DEEPSEEK_PEAK_WINDOWS.map(([a, b]) => {
    const start = a + delta;
    const end = b + delta;
    const shift = Math.floor(start / 1440);
    const days = `${WEEKDAYS[(1 + shift + 7) % 7]}至${WEEKDAYS[(5 + shift + 7) % 7]}`;
    const crosses = Math.floor((end - 1) / 1440) > shift;
    return { days, text: `${hhmm(start)}–${crosses ? '次日 ' : ''}${hhmm(end)}` };
  });
  // Group consecutive windows that fall on the same weekday range.
  const out: string[] = [];
  for (const p of parts) {
    const last = out.length ? out[out.length - 1]! : '';
    if (last.startsWith(p.days)) out[out.length - 1] = `${last}、${p.text}`;
    else out.push(`${p.days} ${p.text}`);
  }
  return out.join('；');
}

export function localTimeZone(): { name: string; offsetMin: number } {
  let name = 'local';
  try {
    name = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  } catch {
    // keep default
  }
  return { name, offsetMin: -new Date().getTimezoneOffset() };
}
