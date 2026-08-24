/**
 * Opening Drive — ORB 1-min, pure decision logic, no I/O, no state.
 *
 * Hyper-Growth cash path: buy the break of the first regular-session 1-min
 * high between 09:30 and 09:45 EST, only when volume or the book accelerates.
 * The caller owns session state; this module only judges a snapshot.
 */

import type { BarData, OpeningDriveDecision, OpeningDriveRejection } from './types';

export interface OpeningDriveContext {
  symbol: string;
  /** Minutes since NY midnight for the impulse bar's own timestamp. */
  barMinutesSinceMidnight: number;
  /**
   * First regular-session 1-min bar (the opening range). Null until captured.
   * The impulse bar must be a later bar — the range bar itself never arms.
   */
  rangeBar: BarData | null;
  /** Previous session close, from the pre-market snapshot. */
  previousClose: number | null;
  /** Open of the first regular-session 1-min bar of the day. */
  sessionOpen: number | null;
  /** Session VWAP — anti-chase reference; required to reach a decision. */
  sessionVwap: number | null;
  /** The 1-min bar being evaluated; must be the last of `oneMinBars`. */
  impulseBar: BarData;
  oneMinBars: readonly BarData[];
  imbalance: number | null;
}

export interface OpeningDriveOptions {
  /** Inclusive window bounds in minutes since NY midnight. */
  windowStartMinutes: number;
  windowEndMinutes: number;
  minRvol1m: number;
  minImbalance: number;
  /** Max tolerated distance above session VWAP. */
  maxExtensionPct: number;
  rvolBaselineBars: number;
  /**
   * Break-bar volume must be at least this multiple of the first-minute volume
   * when 1-min RVOL and book imbalance are both unavailable or short.
   */
  minOrbVolumeMultiple: number;
  /**
   * Minimum stop distance, as a fraction of entry. Applied here so the decision
   * reports the stop that will actually be used: a first-minute low a few
   * basis points away would otherwise inflate size.
   */
  hardStopFloorPct: number;
}

function reject(
  rejection: OpeningDriveRejection,
  partial: Partial<OpeningDriveDecision> = {},
): OpeningDriveDecision {
  return {
    armed: false,
    rejection,
    extensionPct: partial.extensionPct ?? null,
    rvol1m: partial.rvol1m ?? null,
    imbalance: partial.imbalance ?? null,
    entryPrice: partial.entryPrice ?? null,
    stopPrice: partial.stopPrice ?? null,
    score: 0,
  };
}

/**
 * Volume of the impulse bar over the mean of the bars preceding it.
 *
 * Premarket bars in `oneMinBars` are a valid baseline at 09:31 — that is the
 * only history the opening print has.
 */
export function computeOneMinuteRvol(
  bars: readonly BarData[],
  baselineBars: number,
): number | null {
  if (baselineBars < 1 || bars.length < 2) return null;

  const impulse = bars[bars.length - 1];
  const baseline = bars.slice(0, -1).slice(-baselineBars);
  if (baseline.length === 0) return null;

  const meanVolume = baseline.reduce((sum, b) => sum + b.volume, 0) / baseline.length;
  if (meanVolume <= 0) return null;

  return impulse.volume / meanVolume;
}

export function computeOrbVolumeMultiple(
  impulseVolume: number,
  rangeVolume: number,
): number | null {
  if (impulseVolume < 0 || rangeVolume <= 0) return null;
  return impulseVolume / rangeVolume;
}

/**
 * Checks run cheapest-first, with one hard constraint: `max_extension` is last.
 * A setup carrying that code satisfied every other condition.
 */
export function evaluateOpeningDrive(
  ctx: OpeningDriveContext,
  opts: OpeningDriveOptions,
): OpeningDriveDecision {
  const { barMinutesSinceMidnight: minutes } = ctx;
  if (minutes < opts.windowStartMinutes || minutes > opts.windowEndMinutes) {
    return reject('outside_window');
  }

  const { sessionOpen, sessionVwap, impulseBar, rangeBar } = ctx;
  if (sessionOpen === null || sessionOpen <= 0) return reject('insufficient_data');
  if (sessionVwap === null || sessionVwap <= 0) return reject('insufficient_data');

  const price = impulseBar.close;
  if (price <= 0) return reject('insufficient_data');

  if (ctx.previousClose !== null && sessionOpen < ctx.previousClose) {
    return reject('gap_down');
  }

  if (rangeBar === null || rangeBar.high <= 0) return reject('orb_not_ready');
  if (impulseBar.timestamp === rangeBar.timestamp) return reject('orb_not_ready');

  if (price <= sessionOpen) return reject('open_broken');

  const rvol1m = computeOneMinuteRvol(ctx.oneMinBars, opts.rvolBaselineBars);
  const imbalance = ctx.imbalance;
  const extensionPct = (price - sessionVwap) / sessionVwap;
  const observed = { extensionPct, rvol1m, imbalance, entryPrice: price };

  if (price <= rangeBar.high) return reject('no_breakout', observed);

  const vsRange = computeOrbVolumeMultiple(impulseBar.volume, rangeBar.volume);
  const hasRvolSurge = rvol1m !== null && rvol1m > opts.minRvol1m;
  const hasOrbVolumeSurge =
    vsRange !== null && vsRange >= opts.minOrbVolumeMultiple;
  const hasBuyPressure = imbalance !== null && imbalance >= opts.minImbalance;
  if (!hasRvolSurge && !hasOrbVolumeSurge && !hasBuyPressure) {
    return reject('no_momentum', observed);
  }

  if (!(impulseBar.low > 0) || impulseBar.low >= price) {
    return reject('no_impulse_body', observed);
  }

  const floorStop = price * (1 - opts.hardStopFloorPct);
  const structuralStop = rangeBar.low > 0 && rangeBar.low < price
    ? rangeBar.low
    : impulseBar.low;
  const stopPrice = Math.min(structuralStop, floorStop);

  if (extensionPct > opts.maxExtensionPct) {
    return reject('max_extension', { ...observed, stopPrice });
  }

  const breakPct = (price - rangeBar.high) / rangeBar.high;
  const volumeConviction = Math.max(vsRange ?? 1, rvol1m ?? 1);
  const score = impulseBar.volume * Math.max(breakPct, 0) * volumeConviction;

  return {
    armed: true,
    rejection: null,
    extensionPct,
    rvol1m,
    imbalance,
    entryPrice: price,
    stopPrice,
    score,
  };
}

export function describeOpeningDriveDecision(decision: OpeningDriveDecision): string {
  const parts = [
    `ext ${decision.extensionPct === null ? 'N/A' : `${(decision.extensionPct * 100).toFixed(2)}%`}`,
    `rvol1m ${decision.rvol1m === null ? 'N/A' : `${decision.rvol1m.toFixed(2)}x`}`,
    `imbalance ${decision.imbalance === null ? 'N/A' : decision.imbalance.toFixed(3)}`,
  ];
  if (decision.stopPrice !== null) parts.push(`stop $${decision.stopPrice.toFixed(2)}`);
  return parts.join(' | ');
}
