/**
 * Pure daily reversal pattern detectors (spec §3.A) — no I/O.
 *
 * Neckline (ETEI): max of highs on (LS, Head) and (Head, RS) segments.
 * ETEI breakout RVOL uses strict > threshold; Spring reclaim uses >=.
 */

import type { PivotPoint, ReversalPatternSignal } from '../types';

export interface PatternBar {
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ReversalPatternOpts {
  pivotLeft: number;
  pivotRight: number;
  eteiBreakoutRvol: number;
  springReclaimRvol: number;
  springSupportTolerancePct: number;
  rvolAvgDays: number;
}

/** Swing low: low[i] is strictly below lows in [i-left, i+right] excluding i. */
export function findSwingLows(
  bars: readonly PatternBar[],
  left: number,
  right: number,
): PivotPoint[] {
  const pivots: PivotPoint[] = [];
  if (left < 1 || right < 1 || bars.length < left + right + 1) return pivots;

  for (let i = left; i < bars.length - right; i++) {
    const low = bars[i].low;
    let isSwing = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (bars[j].low <= low) {
        isSwing = false;
        break;
      }
    }
    if (isSwing) {
      pivots.push({ index: i, price: low, volume: bars[i].volume });
    }
  }
  return pivots;
}

/**
 * Relative volume at bar index vs average of the prior `avgDays` bars.
 * Returns null if insufficient history or zero average.
 */
export function computeBarRvol(
  bars: readonly PatternBar[],
  index: number,
  avgDays: number,
): number | null {
  if (avgDays < 1 || index < avgDays || index >= bars.length) return null;
  const slice = bars.slice(index - avgDays, index);
  const avg = slice.reduce((sum, b) => sum + b.volume, 0) / avgDays;
  if (avg <= 0) return null;
  return bars[index].volume / avg;
}

function maxHighBetween(
  bars: readonly PatternBar[],
  fromExclusive: number,
  toExclusive: number,
): number | null {
  const start = fromExclusive + 1;
  const end = toExclusive;
  if (start >= end) return null;
  let max = -Infinity;
  for (let i = start; i < end; i++) {
    if (bars[i].high > max) max = bars[i].high;
  }
  return max === -Infinity ? null : max;
}

export function detectEtei(
  bars: readonly PatternBar[],
  opts: ReversalPatternOpts,
): ReversalPatternSignal | null {
  const swings = findSwingLows(bars, opts.pivotLeft, opts.pivotRight);
  if (swings.length < 3) return null;

  // Prefer the most recent valid triplet (scan from end).
  for (let t = swings.length - 1; t >= 2; t--) {
    const ls = swings[t - 2];
    const head = swings[t - 1];
    const rs = swings[t];

    if (!(head.price < ls.price && head.price < rs.price)) continue;
    if (!(rs.price > head.price)) continue;
    if (!(head.volume < ls.volume)) continue;

    const leftPeak = maxHighBetween(bars, ls.index, head.index);
    const rightPeak = maxHighBetween(bars, head.index, rs.index);
    if (leftPeak === null || rightPeak === null) continue;

    // Simplified neckline: max of the two intervening peaks.
    const neckline = Math.max(leftPeak, rightPeak);

    // Breakout: first bar after RS with close > neckline and RVOL > threshold.
    for (let i = rs.index + 1; i < bars.length; i++) {
      if (bars[i].close <= neckline) continue;
      const rvol = computeBarRvol(bars, i, opts.rvolAvgDays);
      if (rvol === null || rvol <= opts.eteiBreakoutRvol) continue;

      return {
        pattern: 'ETEI',
        neckline,
        breakoutRvol: rvol,
        pivots: [ls, head, rs],
      };
    }
  }

  return null;
}

export function detectDoubleBottomSpring(
  bars: readonly PatternBar[],
  opts: ReversalPatternOpts,
): ReversalPatternSignal | null {
  const swings = findSwingLows(bars, opts.pivotLeft, opts.pivotRight);
  if (swings.length < 2) return null;

  const tol = opts.springSupportTolerancePct;

  // Scan recent swing pairs as support touches, then look for spring + reclaim.
  for (let t = swings.length - 1; t >= 1; t--) {
    const touch2 = swings[t];
    const touch1 = swings[t - 1];
    const mid = (touch1.price + touch2.price) / 2;
    if (mid <= 0) continue;
    if (Math.abs(touch1.price - touch2.price) / mid > tol) continue;

    const support = mid;

    // Spring: subsequent swing low (or bar low) below support, then reclaim.
    for (let s = t + 1; s < swings.length; s++) {
      const spring = swings[s];
      if (!(spring.price < support)) continue;

      for (let i = spring.index + 1; i < bars.length; i++) {
        if (bars[i].close <= support) continue;
        const rvol = computeBarRvol(bars, i, opts.rvolAvgDays);
        if (rvol === null || rvol < opts.springReclaimRvol) continue;

        return {
          pattern: 'DOUBLE_BOTTOM_SPRING',
          support,
          reclaimRvol: rvol,
          pivots: [touch1, touch2, spring],
        };
      }
    }

    // Also allow spring as an interim bar low (not necessarily a confirmed swing)
    // after the second support touch — covers compact fixtures.
    for (let i = touch2.index + 1; i < bars.length; i++) {
      if (!(bars[i].low < support)) continue;
      const springPivot: PivotPoint = {
        index: i,
        price: bars[i].low,
        volume: bars[i].volume,
      };
      for (let j = i + 1; j < bars.length; j++) {
        if (bars[j].close <= support) continue;
        const rvol = computeBarRvol(bars, j, opts.rvolAvgDays);
        if (rvol === null || rvol < opts.springReclaimRvol) continue;

        return {
          pattern: 'DOUBLE_BOTTOM_SPRING',
          support,
          reclaimRvol: rvol,
          pivots: [touch1, touch2, springPivot],
        };
      }
    }
  }

  return null;
}

/** ETEI first, then Spring — first match wins. */
export function detectReversalPatterns(
  bars: readonly PatternBar[],
  opts: ReversalPatternOpts,
): ReversalPatternSignal | null {
  return detectEtei(bars, opts) ?? detectDoubleBottomSpring(bars, opts);
}
