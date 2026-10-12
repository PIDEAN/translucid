import { browser } from 'wxt/browser';
import { BUILTIN_EXPERTS } from '../prompt/experts/builtin';
import { LEGACY_PRESET_PRICES, PRESET_CONCURRENCY_HISTORY, PROVIDER_PRESETS } from './presets';
import { vendorOf } from './pricing';
import type { Expert, ProviderConfig, Settings } from './types';

const KEY = 'settings';

export const DEFAULT_SETTINGS: Settings = {
  providers: PROVIDER_PRESETS.map((p) => ({ ...p, extraBody: structuredClone(p.extraBody) })),
  activeProviderId: 'deepseek',
  shortTextProviderId: '',
  refineProviderId: '',
  fallbackProviderId: '',
  packTargetLang: 'zh-CN',
  debugHosts: [],
  displayMode: 'bilingual',
  transStyle: 'faded',
  transFontSize: 'same',
  transLineHeight: 'comfortable',
  autoSpace: true,
  autoTranslate: false,
  builtinSiteRules: true,
  experts: BUILTIN_EXPERTS.map((e) => ({ ...e })),
  glossary: '',
  siteRules: [],
  preprocess: 'auto',
  firstBatchChars: 800,
  firstBatchSegments: 8,
  batchChars: 2000,
  batchSegments: 25,
  shortTextMaxChars: 20,
};

/**
 * Merge stored experts with the builtin list: builtin experts the user never
 * edited follow code updates, edited ones are kept as-is.
 */
function mergeExperts(stored: Expert[] | undefined): Expert[] {
  if (!stored?.length) return DEFAULT_SETTINGS.experts.map((e) => ({ ...e }));
  const result = stored.map((e) => {
    const builtin = BUILTIN_EXPERTS.find((b) => b.id === e.id);
    return builtin && e.builtin && e.version < builtin.version ? { ...builtin } : e;
  });
  for (const b of BUILTIN_EXPERTS) {
    if (!result.some((e) => e.id === b.id)) result.push({ ...b });
  }
  return result;
}

/**
 * Providers saved by older versions: infer the vendor, drop prices that merely
 * repeat an old preset (so the official catalog price applies), and append
 * presets added since.
 */
export function migrateProviders(stored: ProviderConfig[] | undefined): ProviderConfig[] {
  if (!stored?.length) return DEFAULT_SETTINGS.providers.map((p) => ({ ...p, extraBody: structuredClone(p.extraBody) }));
  const list = stored.map((p) => {
    const next: ProviderConfig = { ...p, vendor: vendorOf(p) };
    if (next.vendor === 'deepseek' && !next.region) next.region = 'auto';
    const legacy = LEGACY_PRESET_PRICES[p.id];
    const old = p.price as Record<string, unknown> | undefined;
    if (legacy && old && Object.keys(legacy).every((k) => old[k] === (legacy as Record<string, unknown>)[k]) && Object.keys(old).length === 4) {
      delete next.price;
    }
    return next;
  });
  for (const preset of PROVIDER_PRESETS) {
    if (!list.some((p) => p.id === preset.id)) list.push({ ...preset, extraBody: structuredClone(preset.extraBody) });
  }
  return list;
}

export const PROVIDER_DEFAULTS_REV = PRESET_CONCURRENCY_HISTORY.length;

/** Moves untouched preset concurrency to current defaults and adds RPM caps, for revisions after `fromRev`. */
export function upgradeProviderDefaults(list: ProviderConfig[], fromRev = 0): ProviderConfig[] {
  return list.map((p) => {
    const preset = PROVIDER_PRESETS.find((x) => x.id === p.id);
    if (!preset) return p;
    const next = { ...p };
    for (const old of PRESET_CONCURRENCY_HISTORY.slice(fromRev)) {
      if (old[p.id] === next.concurrency) next.concurrency = preset.concurrency;
    }
    if (next.rpm === undefined && preset.rpm) next.rpm = preset.rpm;
    return next;
  });
}

export function normalizeSettings(raw: Partial<Settings> | undefined): Settings {
  const s = { ...DEFAULT_SETTINGS, ...(raw ?? {}) } as Settings;
  s.experts = mergeExperts(raw?.experts);
  s.providers = migrateProviders(raw?.providers);
  const rev = raw?.providerDefaultsRev ?? 0;
  if (rev < PROVIDER_DEFAULTS_REV && raw?.providers?.length) s.providers = upgradeProviderDefaults(s.providers, rev);
  s.providerDefaultsRev = PROVIDER_DEFAULTS_REV;
  return s;
}

export async function loadSettings(): Promise<Settings> {
  const data = await browser.storage.local.get(KEY);
  return normalizeSettings(data[KEY] as Partial<Settings> | undefined);
}

export async function saveSettings(s: Settings): Promise<void> {
  await browser.storage.local.set({ [KEY]: s });
}

export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const s = { ...(await loadSettings()), ...patch };
  await saveSettings(s);
  return s;
}

export function onSettingsChanged(cb: (s: Settings) => void): void {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) cb(normalizeSettings(changes[KEY].newValue as Partial<Settings>));
  });
}
