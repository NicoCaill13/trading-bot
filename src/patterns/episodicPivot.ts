import type { PriceBar, SwingSetup } from '../types';
import { computeBarRvol } from './bars';

export interface EpisodicPivotOpts {
  minGapPct: number;
  minRvol: number;
  rvolAvgDays: number;
  minCloseLocation: number;
}

/**
 * Gap day that closes in the upper part of its range on a multiple of
 * average volume. The stop is the low of that bar. News confirmation is
 * applied by the caller; this function is price and volume only.
 */
export function detectEpisodicPivot(
  bars: readonly PriceBar[],
  opts: EpisodicPivotOpts,
): SwingSetup | null {
  const n = bars.length;
  if (n < opts.rvolAvgDays + 1) return null;
  const today = bars[n - 1];
  const prev = bars[n - 2];
  if (!(prev.close > 0) || !(today.open > 0)) return null;

  const gap = today.open / prev.close - 1;
  if (gap < opts.minGapPct) return null;

  const rvol = computeBarRvol(bars, n - 1, opts.rvolAvgDays);
  if (rvol === null || rvol < opts.minRvol) return null;

  const range = today.high - today.low;
  if (!(range > 0)) return null;
  const closeLocation = (today.close - today.low) / range;
  if (closeLocation < opts.minCloseLocation) return null;
  if (!(today.high > today.low)) return null;

  return {
    pattern: 'EPISODIC_PIVOT',
    state: 'FRESH_BREAKOUT',
    pivot: today.high,
    stop: today.low,
    rvol,
    thesis:
      `Episodic pivot gap ${(gap * 100).toFixed(1)}% ` +
      `RVOL ${rvol.toFixed(1)}x close location ${(closeLocation * 100).toFixed(0)}%`,
    volumeDryUpRatio: null,
    contractionDepths: [],
  };
}
