import { browser } from 'wxt/browser';
import { monthKey } from '../shared/cost';
import { costOf, resolvedPrice } from '../shared/pricing';
import type { ProviderConfig, UsageBucket, UsageStats } from '../shared/types';
import type { Usage } from './providers';

const KEY = 'usage';
let pending: Record<string, Required<UsageBucket>> = {};
const providers: Record<string, ProviderConfig> = {};
let timer: ReturnType<typeof setTimeout> | undefined;

const empty = (currency = '$'): Required<UsageBucket> => ({
  requests: 0,
  promptTokens: 0,
  cacheHitTokens: 0,
  completionTokens: 0,
  ttftMs: 0,
  ttftCount: 0,
  cost: 0,
  currency,
  subscriptionEquiv: 0,
});

/**
 * Buffer usage in memory and flush to storage at most once per 2s. Cost is
 * computed now, with the rates in force at this moment (DeepSeek peak/off-peak).
 */
export function recordUsage(provider: ProviderConfig, u: Usage | undefined, ttftMs?: number, now = new Date()): void {
  const spec = resolvedPrice(provider);
  providers[provider.id] = provider;
  const b = (pending[provider.id] ??= empty(spec.currency));
  b.requests += 1;
  if (u) {
    b.promptTokens += u.promptTokens;
    b.cacheHitTokens += u.cacheHitTokens;
    b.completionTokens += u.completionTokens;
    if (spec.subscription) b.subscriptionEquiv += costOf(u, { ...spec, subscription: undefined }, now);
    else b.cost += costOf(u, spec, now);
  }
  if (ttftMs !== undefined && ttftMs > 0) {
    b.ttftMs += ttftMs;
    b.ttftCount += 1;
  }
  timer ??= setTimeout(flush, 2000);
}

async function flush(): Promise<void> {
  timer = undefined;
  const batch = pending;
  pending = {};
  const stats = ((await browser.storage.local.get(KEY))[KEY] ?? {}) as UsageStats;
  const month = (stats[monthKey()] ??= {});
  for (const [id, u] of Object.entries(batch)) {
    const b: UsageBucket = (month[id] ??= empty(u.currency));
    // Buckets from before request-time costing: price their old tokens at peak rates once.
    if (typeof b.cost !== 'number' && providers[id]) {
      const spec = resolvedPrice(providers[id]!);
      b.cost = spec.subscription ? 0 : costOf(b, { ...spec, offPeak: undefined });
    }
    b.requests += u.requests;
    b.promptTokens += u.promptTokens;
    b.cacheHitTokens += u.cacheHitTokens;
    b.completionTokens += u.completionTokens;
    b.ttftMs = (b.ttftMs ?? 0) + u.ttftMs;
    b.ttftCount = (b.ttftCount ?? 0) + u.ttftCount;
    b.cost = (b.cost ?? 0) + u.cost;
    b.currency = u.currency;
    b.subscriptionEquiv = (b.subscriptionEquiv ?? 0) + u.subscriptionEquiv;
  }
  await browser.storage.local.set({ [KEY]: stats });
}

export async function loadUsage(): Promise<UsageStats> {
  return ((await browser.storage.local.get(KEY))[KEY] ?? {}) as UsageStats;
}
