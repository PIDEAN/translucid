import type { ProviderVendor } from '../shared/types';

// Single source for the extension icon ("透层": the site's interface layer in cobalt with its
// original line in white, the user's language layer in translucent amber laid over it) and the
// fallback provider badges. scripts/icons.ts rasterizes APP_ICON_SVG into public/icon/*.png;
// the UI renders the same markup.

export const APP_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">' +
  '<rect x="6" y="6" width="84" height="84" rx="22" fill="#2F56D6"/>' +
  '<rect x="38" y="38" width="84" height="84" rx="22" fill="#F2B33D"/>' +
  // Where amber lies over cobalt the layer looks see-through, on any toolbar colour.
  '<path d="M60 38H90V68A22 22 0 0 1 68 90H38V60A22 22 0 0 1 60 38Z" fill="#C79F5F"/>' +
  '<rect x="22" y="24" width="42" height="12" rx="6" fill="#FFFFFF"/>' +
  '<rect x="56" y="76" width="50" height="12" rx="6" fill="#14161B" fill-opacity="0.86"/>' +
  '<rect x="56" y="97" width="31" height="12" rx="6" fill="#14161B" fill-opacity="0.86"/>' +
  '</svg>';

/**
 * Original identification badges (40-unit rounded squares in brand-adjacent
 * colours). They are not the vendors' trademarked logos; drop an official SVG
 * into src/ui/logos/<vendor>.svg to replace one (see provider-logos.ts).
 * All named providers now ship official SVG overrides; only custom uses its badge.
 */
export const PROVIDER_BADGES: Record<ProviderVendor, { label: string; svg: string }> = {
  deepseek: {
    label: 'DeepSeek',
    svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#4D6BFE"/>' +
      '<path d="M9 17c3-3 6-3 9 0s6 3 9 0 4-2 4-2" fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round"/>' +
      '<path d="M9 25c3-3 6-3 9 0s6 3 9 0 4-2 4-2" fill="none" stroke="#FFFFFF" stroke-opacity="0.6" stroke-width="3" stroke-linecap="round"/></svg>',
  },
  glm: {
    label: '智谱',
    // UI only (never rasterized), so the glyph can use the system CJK font.
    svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#1E3A8A"/>' +
      '<text x="20" y="27" text-anchor="middle" font-family="PingFang SC, Noto Sans SC, Microsoft YaHei, sans-serif" font-weight="700" font-size="19" fill="#FFFFFF">智</text></svg>',
  },
  'glm-global': {
    label: 'Z.ai',
    svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#111111"/>' +
      '<path d="M13 13h14L13 27h14" fill="none" stroke="#FFFFFF" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  },
  gemini: {
    label: 'Gemini',
    svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#E8F0FE"/>' +
      '<path d="M27 14.5a8 8 0 1 0 1.5 6.5H20" fill="none" stroke="#1A73E8" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  },
  'opencode-zen': {
    label: 'OpenCode Zen',
    svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#18181B"/>' +
      '<path d="M15 13l-6 7 6 7M25 13l6 7-6 7" fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle cx="20" cy="20" r="3" fill="#2DD4BF"/></svg>',
  },
  'opencode-go': {
    label: 'OpenCode Go',
    svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#18181B"/>' +
      '<path d="M15 13l-6 7 6 7M25 13l6 7-6 7" fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle cx="20" cy="20" r="3" fill="#FFC24B"/></svg>',
  },
  openrouter: {
    label: 'OpenRouter',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path d="M8 20h10l10-10M18 20l10 10M23 10h5v5M23 30h5v-5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  },
  nvidia: {
    label: 'NVIDIA NIM',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path d="M7 20s6-9 13-9 13 9 13 9-6 9-13 9S7 20 7 20z" fill="none" stroke="#76B900" stroke-width="3"/><circle cx="20" cy="20" r="4" fill="#76B900"/></svg>',
  },
  anthropic: {
    label: 'Claude',
    svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#D97757"/>' +
      '<path d="M20 9v22M9 20h22M12.2 12.2l15.6 15.6M27.8 12.2L12.2 27.8" fill="none" stroke="#FFFFFF" stroke-width="3.2" stroke-linecap="round"/></svg>',
  },
  // Generic "文A" translate glyphs in each vendor's colour; not the official marks.
  'google-translate': {
    label: '谷歌翻译',
    svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#1A73E8"/>' +
      '<path d="M9 12h12M15 10v2M19 12c-1 5-4 9-9 11M13 17c1.5 2.5 3.5 4.5 6 5.5" fill="none" stroke="#FFFFFF" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M21 31l5-12 5 12M22.8 27h6.4" fill="none" stroke="#FFFFFF" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  },
  'microsoft-translator': {
    label: '微软翻译',
    svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#0F6CBD"/>' +
      '<path d="M9 12h12M15 10v2M19 12c-1 5-4 9-9 11M13 17c1.5 2.5 3.5 4.5 6 5.5" fill="none" stroke="#FFFFFF" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M21 31l5-12 5 12M22.8 27h6.4" fill="none" stroke="#7FD3FF" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  },
  custom: {
    label: '自定义',
    svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#E9EBEF"/>' +
      '<path d="M16 10v6M24 10v6M13 16h14v4a7 7 0 0 1-14 0zM20 27v4" fill="none" stroke="#3D424B" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  },
};
