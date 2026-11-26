import type { PriceBar, SetupState } from '../types';

export interface PivotStateOpts {
  maxDistanceBelowPct: number;
  maxExtensionPct: number;
  minBreakoutRvol: number;
  rvolAvgDays: number;
}

export function averageVolume(
  bars: readonly PriceBar[],
  from: number,
  toExclusive: number,
): number {
  const n = toExclusive - from;
  if (n <= 0) return 0;
  let sum = 0;
  for (let i = from; i < toExclusive; i++) sum += bars[i].volume;
  return sum / n;
}

export function computeBarRvol(
  bars: readonly PriceBar[],
  index: number,
  avgDays: number,
): number | null {
  if (avgDays < 1 || index < avgDays || index >= bars.length) return null;
  const avg = averageVolume(bars, index - avgDays, index);
  if (avg <= 0) return null;
  return bars[index].volume / avg;
}

/** Swing high: high[i] is strictly above highs in [i-wing, i+wing] excluding i. */
export function findSwingHighs(bars: readonly PriceBar[], wing: number): number[] {
  const indexes: number[] = [];
  if (wing < 1 || bars.length < wing * 2 + 1) return indexes;
  for (let i = wing; i < bars.length - wing; i++) {
    const high = bars[i].high;
    let isSwing = true;
    for (let j = i - wing; j <= i + wing; j++) {
      if (j === i) continue;
      if (bars[j].high >= high) {
        isSwing = false;
        break;
      }
    }
    if (isSwing) indexes.push(i);
  }
  return indexes;
}

/** Swing low: low[i] is strictly below lows in [i-wing, i+wing] excluding i. */
export function findSwingLows(bars: readonly PriceBar[], wing: number): number[] {
  const indexes: number[] = [];
  if (wing < 1 || bars.length < wing * 2 + 1) return indexes;
  for (let i = wing; i < bars.length - wing; i++) {
    const low = bars[i].low;
    let isSwing = true;
    for (let j = i - wing; j <= i + wing; j++) {
      if (j === i) continue;
      if (bars[j].low <= low) {
        isSwing = false;
        break;
      }
    }
    if (isSwing) indexes.push(i);
  }
  return indexes;
}

function trueRange(bars: readonly PriceBar[], i: number): number {
  const high = bars[i].high;
  const low = bars[i].low;
  if (i === 0) return high - low;
  const prevClose = bars[i - 1].close;
  return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
}

/** SMA of true range over `period` bars ending at `endExclusive - 1`. */
export function computeAtrSma(
  bars: readonly PriceBar[],
  endExclusive: number,
  period: number,
): number | null {
  if (period < 1 || endExclusive < period) return null;
  let sum = 0;
  for (let i = endExclusive - period; i < endExclusive; i++) {
    sum += trueRange(bars, i);
  }
  return sum / period;
}

/** Highest high strictly before the last bar, inside [from, toInclusive]. */
export function selectStructuralPivot(
  bars: readonly PriceBar[],
  from: number,
  toInclusive: number,
): { index: number; price: number } | null {
  const last = bars.length - 1;
  const end = Math.min(toInclusive, last - 1);
  if (from > end || from < 0) return null;
  let bestIndex = -1;
  let best = -Infinity;
  for (let i = from; i <= end; i++) {
    if (bars[i].high > best) {
      best = bars[i].high;
      bestIndex = i;
    }
  }
  if (bestIndex < 0 || !(best > 0)) return null;
  return { index: bestIndex, price: best };
}

export interface ResolvedPivot {
  state: SetupState;
  rvol: number | null;
}

/**
 * A setup is actionable only on the last bar.
 * A close above the pivot on any earlier bar is a stale breakout and is rejected.
 */
export function resolveSetupState(
  bars: readonly PriceBar[],
  pivotIndex: number,
  pivot: number,
  opts: PivotStateOpts,
): ResolvedPivot | null {
  const last = bars.length - 1;
  if (last < 0 || !(pivot > 0) || pivotIndex < 0 || pivotIndex >= last) return null;

  for (let i = pivotIndex + 1; i < last; i++) {
    if (bars[i].close > pivot) return null;
  }

  const close = bars[last].close;
  const rvol = computeBarRvol(bars, last, opts.rvolAvgDays);

  if (close > pivot) {
    const extension = (close - pivot) / pivot;
    if (extension > opts.maxExtensionPct) return null;
    if (rvol === null || rvol < opts.minBreakoutRvol) return null;
    return { state: 'FRESH_BREAKOUT', rvol };
  }

  const distanceBelow = (pivot - close) / pivot;
  if (distanceBelow <= opts.maxDistanceBelowPct) {
    return { state: 'FORMING_AT_PIVOT', rvol };
  }
  return null;
}
