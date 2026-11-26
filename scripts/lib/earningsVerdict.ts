/**
 * The pre-registered decision rule of the earnings study, as code, so the
 * verdict cannot be argued after the numbers are seen.
 */

import type { TradeStats } from './eligibleStudy';

const Z_95 = 1.96;

/** Fixed before the run: see prereg-earnings-surprise.md. */
export const MIN_EVENTS = 100;
export const MAX_MDE_PCT = 1.5;
export const MAX_LATE_SHARE = 0.5;

export interface RunningStats {
  count: number;
  mean: number;
  m2: number;
}

export const emptyRunningStats = (): RunningStats => ({ count: 0, mean: 0, m2: 0 });

/** Welford update: stable single-pass mean and variance. */
export function addToRunningStats(stats: RunningStats, value: number): void {
  stats.count += 1;
  const delta = value - stats.mean;
  stats.mean += delta / stats.count;
  stats.m2 += delta * (value - stats.mean);
}

export const sampleStdDev = (stats: RunningStats): number =>
  stats.count > 1 ? Math.sqrt(stats.m2 / (stats.count - 1)) : 0;

/** Smallest mean excess the sample could tell apart from zero: 1.96 standard errors. */
export function minimumDetectableEffectPct(poolStdDevPct: number, n: number): number {
  return n > 0 ? (Z_95 * poolStdDevPct) / Math.sqrt(n) : Number.POSITIVE_INFINITY;
}

export type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE_UNDERPOWERED' | 'INCONCLUSIVE_TIMING';

export interface VerdictInput {
  mdePct: number;
  /** Share of events whose 10-Q came more than one session after the release. */
  lateShare: number;
  /** Out-of-sample selected events: net of cost, and in excess of the baseline. */
  oosAbsolute: TradeStats;
  oosExcess: TradeStats;
  /** Mean over the already-seen sessions, null when there are none. */
  seenAbsoluteMeanPct: number | null;
  seenExcessMeanPct: number | null;
}

const isPositive = (value: number | null): boolean => value !== null && value > 0;

export function decideVerdict(input: VerdictInput): Verdict {
  if (input.mdePct > MAX_MDE_PCT) return 'INCONCLUSIVE_UNDERPOWERED';
  if (input.lateShare > MAX_LATE_SHARE) return 'INCONCLUSIVE_TIMING';

  const passes =
    input.oosAbsolute.n >= MIN_EVENTS &&
    input.oosAbsolute.clusteredCi95LowPct > 0 &&
    input.oosExcess.clusteredCi95LowPct > 0 &&
    isPositive(input.seenAbsoluteMeanPct) &&
    isPositive(input.seenExcessMeanPct);
  return passes ? 'PASS' : 'FAIL';
}
