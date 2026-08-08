/**
 * Pure Weinstein Phase 2 helpers — no I/O, unit-testable.
 *
 * Slope rule: sma150Slope = sma150[t] - sma150[t - slopeLookbackBars]
 * (default slopeLookbackBars = 8 weeks × 5 sessions = 40). Accept when slope >= 0.
 */

export interface WeinsteinAssessment {
  sma150: number;
  sma200: number;
  /** sma150[t] - sma150[t - slopeLookbackBars]; >= 0 required for Phase 2. */
  sma150Slope: number;
  lastClose: number;
  priceAboveSmas: boolean;
  slopeNonNegative: boolean;
  isPhase2: boolean;
}

export interface WeinsteinOpts {
  sma150Period: number;
  sma200Period: number;
  slopeLookbackBars: number;
}

/** Simple moving average of the last `period` closes (oldest → newest array). */
export function computeSma(
  closes: readonly number[],
  period: number,
): number | null {
  return computeSmaAt(closes, closes.length, period);
}

/**
 * SMA ending at `endExclusive` (exclusive index into closes).
 * Uses closes[endExclusive - period .. endExclusive - 1].
 */
export function computeSmaAt(
  closes: readonly number[],
  endExclusive: number,
  period: number,
): number | null {
  if (period < 1 || endExclusive < period) return null;

  const start = endExclusive - period;
  let sum = 0;
  for (let i = start; i < endExclusive; i++) {
    const c = closes[i];
    if (!(c > 0)) return null;
    sum += c;
  }
  return sum / period;
}

/**
 * Assess Weinstein Phase 2 on daily closes (oldest → newest).
 * Needs at least sma200Period + slopeLookbackBars closes.
 */
export function assessWeinsteinPhase2(
  closes: readonly number[],
  opts: WeinsteinOpts,
): WeinsteinAssessment | null {
  const { sma150Period, sma200Period, slopeLookbackBars } = opts;
  if (
    sma150Period < 1 ||
    sma200Period < 1 ||
    slopeLookbackBars < 1 ||
    sma200Period < sma150Period
  ) {
    return null;
  }

  const minNeeded = sma200Period + slopeLookbackBars;
  if (closes.length < minNeeded) return null;

  const end = closes.length;
  const lastClose = closes[end - 1];
  if (!(lastClose > 0)) return null;

  const sma150 = computeSmaAt(closes, end, sma150Period);
  const sma200 = computeSmaAt(closes, end, sma200Period);
  const sma150Prev = computeSmaAt(closes, end - slopeLookbackBars, sma150Period);
  if (sma150 === null || sma200 === null || sma150Prev === null) return null;

  // Documented rule: accept non-negative slope (flat → rising) over the lookback.
  const sma150Slope = sma150 - sma150Prev;
  const priceAboveSmas = lastClose > sma150 && lastClose > sma200;
  const slopeNonNegative = sma150Slope >= 0;
  const isPhase2 = priceAboveSmas && slopeNonNegative;

  return {
    sma150,
    sma200,
    sma150Slope,
    lastClose,
    priceAboveSmas,
    slopeNonNegative,
    isPhase2,
  };
}

export function passesWeinsteinGate(a: WeinsteinAssessment): boolean {
  return a.isPhase2;
}
