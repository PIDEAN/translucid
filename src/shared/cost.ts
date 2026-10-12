import { costOf, resolvedPrice } from './pricing';
import type { ProviderConfig, UsageBucket } from './types';

export interface CostLine {
  amount: number;
  currency: string;
}

/**
 * Cost of a usage bucket. Buckets recorded since peak/off-peak support carry the
 * cost computed at request time; older ones are priced at today's peak rates.
 */
export function estimateCost(b: UsageBucket, p: ProviderConfig | undefined): CostLine {
  if (typeof b.cost === 'number') return { amount: b.cost, currency: b.currency ?? (p ? resolvedPrice(p).currency : '$') };
  if (!p) return { amount: 0, currency: '$' };
  const spec = resolvedPrice(p);
  return { amount: costOf(b, { ...spec, offPeak: undefined }), currency: spec.currency };
}

export function formatCost(v: number, currency = '$'): string {
  return `${currency}${v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2)}`;
}

/** Sum per currency and format, e.g. "¥0.42 + $0.13"; "¥0.00" when empty. */
export function formatCostLines(lines: CostLine[], fallbackCurrency = '¥'): string {
  const sums = new Map<string, number>();
  for (const l of lines) sums.set(l.currency, (sums.get(l.currency) ?? 0) + l.amount);
  const nonZero = [...sums].filter(([, v]) => v > 0);
  if (!nonZero.length) return formatCost(0, [...sums.keys()][0] ?? fallbackCurrency);
  return nonZero.map(([c, v]) => formatCost(v, c)).join(' + ');
}

export const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
