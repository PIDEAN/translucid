export type DisplayMode = 'bilingual' | 'replace';

export type TransStyle = 'plain' | 'faded' | 'border' | 'dashed' | 'tint';

export type TransFontSize = 'same' | 'small';

export type TransLineHeight = 'comfortable' | 'compact' | 'inherit';

export type ProviderVendor = 'deepseek' | 'glm' | 'glm-global' | 'gemini' | 'opencode-zen' | 'opencode-go' | 'openrouter' | 'nvidia' | 'anthropic' | 'google-translate' | 'microsoft-translator' | 'custom';

/** DeepSeek bills CN accounts in CNY and global accounts in USD on the same endpoint. */
export type ProviderRegion = 'auto' | 'cn' | 'global';

/**
 * User overrides of the catalog price (per 1M tokens). Missing fields mean "use the
 * default", so clearing an input falls back to the official price shown as placeholder.
 */
export interface PriceOverride {
  input?: number;
  cacheHit?: number;
  output?: number;
  /** Off-peak rates (DeepSeek). */
  offInput?: number;
  offCacheHit?: number;
  offOutput?: number;
  currency?: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  /** OpenAI-compatible base, e.g. https://api.deepseek.com/v1 (no trailing /chat/completions). */
  baseURL: string;
  apiKey: string;
  model: string;
  /** Merged into the request body. Used for provider switches such as disabling thinking. */
  extraBody: Record<string, unknown>;
  /** Send stream_options.include_usage. Some endpoints reject it. */
  includeUsage: boolean;
  concurrency: number;
  /** Which service this is; drives default prices and model suggestions. Inferred from baseURL when absent. */
  vendor?: ProviderVendor;
  /** Client-side cap on requests per minute (0 / absent = none), for RPM-limited free tiers. */
  rpm?: number;
  /** DeepSeek only: which site the account belongs to. */
  region?: ProviderRegion;
  /** DeepSeek only: region reported by GET /user/balance (CNY → cn, USD → global). */
  detectedRegion?: 'cn' | 'global';
  price?: PriceOverride;
}

export interface Expert {
  id: string;
  name: string;
  /** Host globs (`*.github.com`, `arxiv.org`) or host+path globs (`*\/terms*`). */
  matches: string[];
  /** Domain rules appended to the system prompt, one per line. */
  rules: string;
  version: number;
  builtin?: boolean;
}

export interface GlossaryEntry {
  src: string;
  /** `KEEP` means keep the source term untranslated. */
  tgt: string;
  note?: string;
}

export type SiteMode = 'default' | 'always' | 'never';

export interface SiteRule {
  /** Host glob, e.g. `*.reddit.com`. */
  host: string;
  mode: SiteMode;
  expertId?: string;
  /** Only translate inside these selectors (comma separated). */
  include?: string;
  /** Never translate inside these selectors (comma separated). */
  exclude?: string;
  /** Glossary lines in `src => tgt # note` form. */
  glossary?: string;
}

export interface Settings {
  providers: ProviderConfig[];
  /** One-time provider default upgrades already applied (index into PRESET_CONCURRENCY_HISTORY). */
  providerDefaultsRev?: number;
  activeProviderId: string;
  /** Optional cheaper/free provider for short UI strings. */
  shortTextProviderId: string;
  /** Provider for manual 精翻; empty means the active one. */
  refineProviderId: string;
  /** Used when the main / short-text LLM is rate limited, overloaded or erroring ('' = none). */
  fallbackProviderId?: string;
  /** Default target language for new site language packs. */
  packTargetLang?: string;
  /** Debug builds only: hosts where the page debug bridge accepts pack commands (default none). */
  debugHosts?: string[];
  displayMode: DisplayMode;
  transStyle: TransStyle;
  transFontSize: TransFontSize;
  transLineHeight: TransLineHeight;
  /** Pangu-style spaces between Chinese and Latin text, applied locally. */
  autoSpace: boolean;
  /** Translate every non-Chinese page automatically. */
  autoTranslate: boolean;
  /** Apply built-in exclusions for common sites (menus, vote counts, reference lists). */
  builtinSiteRules: boolean;
  experts: Expert[];
  /** Global glossary in `src => tgt # note` lines. */
  glossary: string;
  siteRules: SiteRule[];
  preprocess: 'auto' | 'on' | 'off';
  firstBatchChars: number;
  firstBatchSegments: number;
  batchChars: number;
  batchSegments: number;
  /** Strings shorter than this go to shortTextProviderId when set. */
  shortTextMaxChars: number;
}

/** A unit sent from content to background. */
export interface SegmentPayload {
  id: number;
  /** Serialized text with inline tags (<a1>…</a1>) and atoms ({{1}}). */
  text: string;
}

export interface PageContext {
  url: string;
  host: string;
  title: string;
}

export interface UsageBucket {
  requests: number;
  promptTokens: number;
  cacheHitTokens: number;
  completionTokens: number;
  /** Sum and count of time-to-first-token, for the average shown in Options. */
  ttftMs?: number;
  ttftCount?: number;
  /** Cost accumulated at request time with the rates then in force (peak/off-peak aware). */
  cost?: number;
  currency?: string;
  /** Pay-as-you-go equivalent consumed by subscription plans (OpenCode Go). */
  subscriptionEquiv?: number;
}

/** What preprocessing learned about a page; shown in the popup. */
export interface PageInfo {
  topic?: string;
  scene?: string;
  terms: GlossaryEntry[];
}

/** month (YYYY-MM) -> providerId -> bucket */
export type UsageStats = Record<string, Record<string, UsageBucket>>;
