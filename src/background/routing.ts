// Provider selection and per-provider admission, shared by page translation and
// site language pack generation so both respect the same limits, fallback and
// circuit breaker.
import { isMachineTranslation, providerReady } from '../shared/pricing';
import type { ProviderConfig, Settings } from '../shared/types';
import { ProviderGate } from './batching';

const gates = new Map<string, ProviderGate>();

/** One gate per provider, shared by all tabs and jobs; settings edits apply in place. */
export function providerGate(p: ProviderConfig): ProviderGate {
  let g = gates.get(p.id);
  if (!g) gates.set(p.id, (g = new ProviderGate(1)));
  g.concurrency = Math.max(1, Math.round(p.concurrency));
  g.rpm = Math.max(0, p.rpm ?? 0);
  return g;
}

export function usableProvider(s: Settings, id: string): ProviderConfig | undefined {
  const p = s.providers.find((x) => x.id === id);
  return p && providerReady(p) ? p : undefined;
}

/** Provider to use when `p` keeps failing; never `p` itself or machine translation. */
export function fallbackFor(s: Settings, p: ProviderConfig): ProviderConfig | undefined {
  const f = s.fallbackProviderId ? usableProvider(s, s.fallbackProviderId) : undefined;
  return f && f.id !== p.id && !isMachineTranslation(f) ? f : undefined;
}

/** Main (LLM) provider; machine translation can only serve short text. */
export function mainProvider(s: Settings): ProviderConfig {
  const llm = (p?: ProviderConfig) => (p && !isMachineTranslation(p) ? p : undefined);
  return (
    llm(usableProvider(s, s.activeProviderId)) ??
    llm(s.providers.find((p) => p.id === s.activeProviderId)) ??
    s.providers.find((p) => !isMachineTranslation(p))!
  );
}
