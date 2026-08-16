import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { CostTracker } from '../src/core/cost-tracker.js';
import {
  isPeakHour,
  msUntilNextValley,
  estimateCostUsd,
  estimateTokensFromText,
  V4_PRICING
} from '../src/core/peak-pricing.js';

function utcDate(hour: number, minute = 0): Date {
  const d = new Date('2026-08-17T00:00:00Z');
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

describe('Peak/off-peak tariff (official V4 schedule)', () => {
  it('peak windows are UTC 01-04 and 06-10, half-open', () => {
    expect(isPeakHour(utcDate(0, 59))).toBe(false);
    expect(isPeakHour(utcDate(1))).toBe(true);
    expect(isPeakHour(utcDate(3, 59))).toBe(true);
    expect(isPeakHour(utcDate(4))).toBe(false);
    expect(isPeakHour(utcDate(5))).toBe(false);
    expect(isPeakHour(utcDate(6))).toBe(true);
    expect(isPeakHour(utcDate(9, 59))).toBe(true);
    expect(isPeakHour(utcDate(10))).toBe(false);
    expect(isPeakHour(utcDate(23))).toBe(false);
  });

  it('msUntilNextValley: 0 off-peak, exact window end during peak', () => {
    expect(msUntilNextValley(utcDate(12))).toBe(0);
    expect(msUntilNextValley(utcDate(2))).toBe(2 * 60 * 60 * 1000);
    expect(msUntilNextValley(utcDate(6, 30))).toBe(3.5 * 60 * 60 * 1000);
  });

  it('prices: off-peak is exactly half of peak; hit vs miss ratio holds', () => {
    for (const model of Object.keys(V4_PRICING) as Array<keyof typeof V4_PRICING>) {
      const { peak, offpeak } = V4_PRICING[model];
      expect(offpeak.hit).toBeCloseTo(peak.hit / 2, 10);
      expect(offpeak.miss).toBeCloseTo(peak.miss / 2, 10);
      expect(offpeak.output).toBeCloseTo(peak.output / 2, 10);
    }
    // Flash miss at peak: $0.44/1M → 1M tokens cost $0.44.
    expect(estimateCostUsd('deepseek-v4-flash', { missTokens: 1_000_000 }, utcDate(8))).toBeCloseTo(0.44, 6);
    // Same usage off-peak is half.
    expect(estimateCostUsd('deepseek-v4-flash', { missTokens: 1_000_000 }, utcDate(12))).toBeCloseTo(0.22, 6);
    // Pro cache hit at peak: $0.022/1M.
    expect(estimateCostUsd('deepseek-v4-pro', { hitTokens: 1_000_000 }, utcDate(8))).toBeCloseTo(0.022, 6);
    // Unknown models cost 0 (tracked, unpriced).
    expect(estimateCostUsd('agnes-2.5-pro', { missTokens: 1_000_000 })).toBe(0);
    expect(estimateTokensFromText('abcd'.repeat(10))).toBe(12);
  });
});

describe('CostTracker ledger', () => {
  let db: Database.Database;
  let tracker: CostTracker;

  beforeEach(() => {
    db = new Database(':memory:');
    tracker = new CostTracker(db);
  });

  afterEach(() => {
    db.close();
  });

  it('aggregates by purpose and model, pricing at the recorded moment', () => {
    tracker.record({
      model: 'deepseek-v4-flash',
      purpose: 'distill',
      missTokens: 1_000_000,
      outputTokens: 1_000_000,
      estimated: true
    });
    tracker.recordEstimatedText('deepseek-v4-flash', 'consolidate', 'x'.repeat(3500), 'y'.repeat(3500));

    const report = tracker.getReport(7);
    expect(report.totalUsd).toBeGreaterThan(0);
    expect(report.byPurpose.length).toBe(2);
    const distill = report.byPurpose.find((p) => p.purpose === 'distill')!;
    expect(distill.calls).toBe(1);
    expect(distill.tokens.miss).toBe(1_000_000);
    expect(report.estimatedTokenShare).toBeGreaterThan(0.9);
    expect(report.byModel[0].model).toBe('deepseek-v4-flash');
  });

  it('keeps an empty report clean', () => {
    const report = tracker.getReport(30);
    expect(report.totalUsd).toBe(0);
    expect(report.byPurpose).toEqual([]);
    expect(report.estimatedTokenShare).toBe(0);
  });
});
