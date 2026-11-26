import type { PriceBar, SwingSetup } from '../types';
import { computeBarRvol, findSwingLows } from './bars';

export interface ReversalOpts {
  swingWing: number;
  springReclaimRvol: number;
  springSupportTolerancePct: number;
  eteiBreakoutRvol: number;
  rvolAvgDays: number;
  /** Reclaim / breakout must sit on the last bar or the one before it. */
  maxAgeBars: number;
  maxExtensionPct: number;
}

interface Pivot {
  index: number;
  price: number;
  volume: number;
}

function swingLows(bars: readonly PriceBar[], wing: number): Pivot[] {
  return findSwingLows(bars, wing).map(index => ({
    index,
    price: bars[index].low,
    volume: bars[index].volume,
  }));
}

function maxHighBetween(
  bars: readonly PriceBar[],
  fromExclusive: number,
  toExclusive: number,
): number | null {
  const start = fromExclusive + 1;
  if (start >= toExclusive) return null;
  let max = -Infinity;
  for (let i = start; i < toExclusive; i++) {
    if (bars[i].high > max) max = bars[i].high;
  }
  return max === -Infinity ? null : max;
}

function freshEnough(index: number, length: number, maxAgeBars: number): boolean {
  return index >= length - 1 - maxAgeBars && index <= length - 1;
}

/**
 * Inverse head-and-shoulders whose neckline break is still the current bar
 * or the bar just before it, and price has not run more than maxExtensionPct.
 */
export function detectEtei(bars: readonly PriceBar[], opts: ReversalOpts): SwingSetup | null {
  const swings = swingLows(bars, opts.swingWing);
  if (swings.length < 3) return null;
  const last = bars.length - 1;

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
    const neckline = Math.max(leftPeak, rightPeak);

    for (let i = rs.index + 1; i < bars.length; i++) {
      if (bars[i].close <= neckline) continue;
      if (!freshEnough(i, bars.length, opts.maxAgeBars)) continue;
      const rvol = computeBarRvol(bars, i, opts.rvolAvgDays);
      if (rvol === null || rvol < opts.eteiBreakoutRvol) continue;
      const extension = (bars[last].close - neckline) / neckline;
      if (extension < 0 || extension > opts.maxExtensionPct) continue;
      return {
        pattern: 'ETEI',
        state: i === last ? 'FRESH_BREAKOUT' : 'FORMING_AT_PIVOT',
        pivot: neckline,
        stop: rs.price,
        rvol,
        thesis: 'Inverse head and shoulders, neckline just reclaimed',
        volumeDryUpRatio: null,
        contractionDepths: [],
      };
    }
  }
  return null;
}

/**
 * Wyckoff spring: two tests of a support, a poke underneath, then a reclaim
 * on volume that is still only one or two sessions old.
 */
export function detectWyckoffSpring(
  bars: readonly PriceBar[],
  opts: ReversalOpts,
): SwingSetup | null {
  const swings = swingLows(bars, opts.swingWing);
  if (swings.length < 2) return null;
  const last = bars.length - 1;
  const tol = opts.springSupportTolerancePct;

  for (let t = swings.length - 1; t >= 1; t--) {
    const touch2 = swings[t];
    const touch1 = swings[t - 1];
    const mid = (touch1.price + touch2.price) / 2;
    if (!(mid > 0)) continue;
    if (Math.abs(touch1.price - touch2.price) / mid > tol) continue;

    for (let i = touch2.index + 1; i < bars.length; i++) {
      if (!(bars[i].low < mid)) continue;
      const springLow = bars[i].low;
      for (let j = i + 1; j < bars.length; j++) {
        if (bars[j].close <= mid) continue;
        if (!freshEnough(j, bars.length, opts.maxAgeBars)) continue;
        const rvol = computeBarRvol(bars, j, opts.rvolAvgDays);
        if (rvol === null || rvol < opts.springReclaimRvol) continue;
        const extension = (bars[last].close - mid) / mid;
        if (bars[last].close < mid || extension > opts.maxExtensionPct) continue;
        return {
          pattern: 'WYCKOFF_SPRING',
          state: j === last ? 'FRESH_BREAKOUT' : 'FORMING_AT_PIVOT',
          pivot: mid,
          stop: springLow,
          rvol,
          thesis: 'Spring under support and reclaim on volume',
          volumeDryUpRatio: null,
          contractionDepths: [],
        };
      }
      break;
    }
  }
  return null;
}
