import type { ProviderConfig } from './types';

// Endpoints, model names and switches as of 2026-10. Prices come from the
// catalog in pricing.ts (defaults shown as placeholders in Options); every field
// stays editable.
export const PROVIDER_PRESETS: ProviderConfig[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    vendor: 'deepseek',
    region: 'auto',
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-flash',
    // V4.x Flash defaults to thinking=high; translation must not pay for reasoning tokens.
    extraBody: { thinking: { type: 'disabled' } },
    includeUsage: true,
    // Account-level cap is 2500 concurrent requests (deepseek-flash); 12 keeps peak-hour 503s rare.
    concurrency: 12,
  },
  {
    id: 'glm',
    name: '智谱 GLM 国内站（免费）',
    vendor: 'glm',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: '',
    model: 'glm-4.7-flash',
    extraBody: { thinking: { type: 'disabled' } },
    includeUsage: false,
    // Free tier reportedly allows a single concurrent request.
    concurrency: 1,
  },
  {
    id: 'glm-global',
    name: 'Z.ai GLM 国际站（免费）',
    vendor: 'glm-global',
    baseURL: 'https://api.z.ai/api/paas/v4',
    apiKey: '',
    model: 'glm-4.7-flash',
    extraBody: { thinking: { type: 'disabled' } },
    includeUsage: false,
    concurrency: 1,
  },
  {
    id: 'gemini',
    name: 'Gemini Flash-Lite',
    vendor: 'gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKey: '',
    model: 'gemini-3.1-flash-lite',
    // Gemini 3.x cannot fully disable thinking; minimal is the floor.
    extraBody: { reasoning_effort: 'minimal' },
    includeUsage: true,
    // Free tier ≈ 15 RPM / 500 RPD for Flash-Lite (AI Studio shows exact quota); clear rpm on a paid tier.
    concurrency: 3,
    rpm: 15,
  },
  {
    id: 'opencode-zen',
    name: 'OpenCode Zen（按量）',
    vendor: 'opencode-zen',
    baseURL: 'https://opencode.ai/zen/v1',
    apiKey: '',
    // Only /chat/completions models work here (DeepSeek, GLM, Kimi, Qwen, MiniMax, free models).
    model: 'deepseek-v4.1-flash',
    extraBody: {},
    includeUsage: true,
    concurrency: 6,
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go（订阅）',
    vendor: 'opencode-go',
    baseURL: 'https://opencode.ai/zen/go/v1',
    apiKey: '',
    model: 'deepseek-v4.1-flash',
    extraBody: {},
    includeUsage: true,
    concurrency: 6,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter（免费）',
    vendor: 'openrouter',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: '',
    model: 'openrouter/free',
    extraBody: { reasoning: { enabled: false } },
    includeUsage: true,
    // Free models: 20 RPM, 50 RPD (1000 RPD after buying ≥10 credits).
    concurrency: 1,
    rpm: 18,
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM（免费试用）',
    vendor: 'nvidia',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    apiKey: '',
    model: 'nvidia/nemotron-3-super-120b-a12b',
    // NVIDIA's documented non-reasoning mode and recommended sampling settings.
    extraBody: { max_tokens: 4096, temperature: 1, top_p: 0.95, chat_template_kwargs: { enable_thinking: false } },
    includeUsage: false,
    // Trial limits are unpublished; ~40 RPM is widely reported. The RPM cap guards the
    // quota, so concurrency only decides how fast that budget is spent (2 queued for 5 s+).
    concurrency: 4,
    rpm: 35,
  },
  {
    id: 'anthropic',
    name: 'Claude Haiku 5.5',
    vendor: 'anthropic',
    // Messages API through the official SDK (not OpenAI-compatible); see src/background/anthropic.ts.
    baseURL: 'https://api.anthropic.com',
    apiKey: '',
    model: 'claude-haiku-5-5',
    // Code defaults: thinking disabled + effort medium; set e.g. {"output_config":{"effort":"low"}} to override.
    extraBody: {},
    includeUsage: true,
    // Start tier: 1000 RPM / 2M ITPM (cache reads excluded) / 400K OTPM for Haiku 5.5.
    concurrency: 8,
  },
  {
    id: 'google-translate',
    name: '谷歌翻译（免费·短文本）',
    vendor: 'google-translate',
    // Keyless translate-widget endpoint (client=gtx); plain short strings only, see src/background/mt.ts.
    baseURL: 'https://translate.googleapis.com',
    apiKey: '',
    model: 'gtx',
    extraBody: {},
    includeUsage: false,
    // Undocumented per-IP throttling (429 after quick bursts); requests are batched, so 2 is plenty.
    concurrency: 2,
    rpm: 30,
  },
  {
    id: 'microsoft-translator',
    name: '微软翻译（免费·短文本）',
    vendor: 'microsoft-translator',
    // Edge's built-in translator endpoint; keyless, up to 100 strings per request.
    baseURL: 'https://edge.microsoft.com',
    apiKey: '',
    model: 'edge',
    extraBody: {},
    includeUsage: false,
    concurrency: 4,
  },
  {
    id: 'custom',
    name: '自定义 OpenAI 兼容',
    vendor: 'custom',
    baseURL: 'https://api.openai.com/v1',
    apiKey: '',
    model: '',
    extraBody: {},
    includeUsage: true,
    concurrency: 4,
  },
];

/**
 * Superseded concurrency defaults, one map per settings revision. A stored value
 * equal to the old default of a revision the settings have not seen yet moves to
 * the current preset value (see upgradeProviderDefaults); edited values stay.
 */
export const PRESET_CONCURRENCY_HISTORY: Record<string, number>[] = [
  // rev 1, 2026-10-11 rate-limit review
  { deepseek: 6, gemini: 4, 'opencode-zen': 4, 'opencode-go': 4, nvidia: 1, anthropic: 4 },
  // rev 2, TechPowerUp test: NVIDIA at 2 lanes queued batches for 5–8 s
  { nvidia: 2 },
];

/** Prices the presets used to carry before the catalog existed; matching stored values are dropped on load. */
export const LEGACY_PRESET_PRICES: Record<string, { input: number; cacheHit: number; output: number; currency: string }> = {
  deepseek: { input: 0.3, cacheHit: 0.006, output: 1.2, currency: '$' },
  glm: { input: 0, cacheHit: 0, output: 0, currency: '¥' },
  gemini: { input: 0.25, cacheHit: 0.025, output: 1.5, currency: '$' },
};
