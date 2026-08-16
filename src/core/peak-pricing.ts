/**
 * DeepSeek-V4 peak/off-peak tariff utilities.
 *
 * Official pricing page (2026-08-16 schedule): peak windows are
 * UTC 01:00–04:00 and 06:00–10:00; every other hour is off-peak and all
 * off-peak rates are exactly half of the peak rates.
 * In Beijing time (UTC+8) the peak windows are 09:00–12:00 and
 * 14:00–18:00 — i.e. the whole local workday — so deferred batch work
 * (distillation / consolidation) should be scheduled into the valley.
 */

export type Tariff = 'peak' | 'offpeak';

/** Half-open [startHour, endHour) windows in UTC. */
export const PEAK_WINDOWS_UTC: ReadonlyArray<readonly [number, number]> = [
  [1, 4],
  [6, 10]
];

export function isPeakHour(at: Date = new Date()): boolean {
  const hour = at.getUTCHours();
  return PEAK_WINDOWS_UTC.some(([start, end]) => hour >= start && hour < end);
}

/** Milliseconds from `at` until the next off-peak moment (0 when already off-peak). */
export function msUntilNextValley(at: Date = new Date()): number {
  if (!isPeakHour(at)) return 0;
  const hour = at.getUTCHours();
  const window = PEAK_WINDOWS_UTC.find(([start, end]) => hour >= start && hour < end)!;
  const valleyAt = new Date(at);
  valleyAt.setUTCHours(window[1], 0, 0, 0);
  return Math.max(0, valleyAt.getTime() - at.getTime());
}

export type V4ModelId = 'deepseek-v4-pro' | 'deepseek-v4-flash';

/** USD per 1M tokens. Off-peak is exactly half of peak for every cell. */
interface RateCard {
  hit: number;
  miss: number;
  output: number;
}

export const V4_PRICING: Record<V4ModelId, { peak: RateCard; offpeak: RateCard }> = {
  'deepseek-v4-pro': {
    peak: { hit: 0.022, miss: 1.32, output: 3.96 },
    offpeak: { hit: 0.011, miss: 0.66, output: 1.98 }
  },
  'deepseek-v4-flash': {
    peak: { hit: 0.014, miss: 0.44, output: 1.32 },
    offpeak: { hit: 0.007, miss: 0.22, output: 0.66 }
  }
};

export function resolveModelId(model: string): V4ModelId | null {
  if (model.includes('v4-pro')) return 'deepseek-v4-pro';
  if (model.includes('v4-flash')) return 'deepseek-v4-flash';
  return null;
}

export interface TokenUsage {
  hitTokens?: number;
  missTokens?: number;
  outputTokens?: number;
}

/** Cost in USD for the given usage at the tariff active at `at` (unknown models cost 0). */
export function estimateCostUsd(model: string, usage: TokenUsage, at: Date = new Date()): number {
  const id = resolveModelId(model);
  if (!id) return 0;
  const card = V4_PRICING[id][isPeakHour(at) ? 'peak' : 'offpeak'];
  const m = (n: number | undefined) => (n ?? 0) / 1_000_000;
  return (
    m(usage.hitTokens) * card.hit +
    m(usage.missTokens) * card.miss +
    m(usage.outputTokens) * card.output
  );
}

/** Character-count token estimator consistent with the working-set budget math. */
export function estimateTokensFromText(text: string): number {
  return Math.ceil((text || '').length / 3.5);
}
