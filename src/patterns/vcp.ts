import type { PriceBar, SwingSetup } from '../types';
import {
  averageVolume,
  findSwingHighs,
  resolveSetupState,
  type PivotStateOpts,
} from './bars';

export interface VcpOpts extends PivotStateOpts {
  swingWing: number;
  minBaseBars: number;
  maxBaseBars: number;
  minContractions: number;
  maxContractions: number;
  contractionRatio: number;
  maxLastContraction: number;
  dryUpRatio: number;
  dryUpLookback: number;
}

export function contractionsAreTightening(
  depths: readonly number[],
  maxRatio: number,
  maxLast: number,
): boolean {
  if (depths.length < 2) return false;
  for (const depth of depths) {
    if (!(depth > 0)) return false;
  }
  for (let i = 1; i < depths.length; i++) {
    if (!(depths[i] <= depths[i - 1] * maxRatio + 1e-12)) return false;
  }
  return depths[depths.length - 1] <= maxLast;
}

/**
 * Volatility contraction: 2 to 5 successively tighter pullbacks, the last one
 * no deeper than 10%, volume drying up on the right side, pivot not yet stale.
 */
export function detectVcp(bars: readonly PriceBar[], opts: VcpOpts): SwingSetup | null {
  const n = bars.length;
  if (n < opts.minBaseBars) return null;

  const windowStart = Math.max(0, n - opts.maxBaseBars);
  const window = bars.slice(windowStart);
  const highs = findSwingHighs(window, opts.swingWing);
  if (highs.length < 2) return null;

  const recent = highs.slice(-(opts.maxContractions));
  const depths: number[] = [];
  for (let k = 0; k < recent.length - 1; k++) {
    const from = recent[k];
    const to = recent[k + 1];
    const pivotHigh = window[from].high;
    let low = Infinity;
    for (let i = from; i <= to; i++) {
      if (window[i].low < low) low = window[i].low;
    }
    if (!(pivotHigh > low)) return null;
    depths.push((pivotHigh - low) / pivotHigh);
  }

  const lastHigh = recent[recent.length - 1];
  const pivot = window[lastHigh].high;
  let tailLow = Infinity;
  for (let i = lastHigh; i < window.length; i++) {
    if (window[i].low < tailLow) tailLow = window[i].low;
  }
  if (!(pivot > tailLow)) return null;
  depths.push((pivot - tailLow) / pivot);

  const used = depths.slice(-opts.maxContractions);
  if (used.length < opts.minContractions) return null;
  if (!contractionsAreTightening(used, opts.contractionRatio, opts.maxLastContraction)) {
    return null;
  }

  const globalPivot = windowStart + lastHigh;
  const dryFrom = globalPivot;
  const dryTo = bars[n - 1].close > pivot ? n - 1 : n;
  const dryAvg = averageVolume(bars, dryFrom, dryTo);
  const baseFrom = Math.max(0, dryFrom - opts.dryUpLookback);
  const baseAvg = averageVolume(bars, baseFrom, dryFrom);
  if (!(baseAvg > 0) || dryAvg > opts.dryUpRatio * baseAvg) return null;

  const resolved = resolveSetupState(bars, globalPivot, pivot, opts);
  if (resolved === null) return null;

  const depthText = used.map(d => `${(d * 100).toFixed(1)}%`).join(' → ');
  return {
    pattern: 'VCP',
    state: resolved.state,
    pivot,
    stop: tailLow,
    rvol: resolved.rvol,
    thesis: `VCP ${used.length} contractions (${depthText}), volume dry-up ${(dryAvg / baseAvg).toFixed(2)}x`,
    volumeDryUpRatio: dryAvg / baseAvg,
    contractionDepths: used,
  };
}
