/**
 * Opening Drive — ORB 1-min, pure decision logic, no I/O, no state.
 *
 * Hyper-Growth cash path: buy the break of the first regular-session 1-min
 * high between 09:30 and 09:45 EST when volume confirms the extension and the
 * impulse bar closes in its upper tertile. A gap is not required — yesterday's
 * close is diagnostic. Quotes veto a wide spread (fail open when missing).
 * Signed tape vetoes selling pressure (fail open when missing). Snapshot IEX
 * imbalance is diagnostic only.
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
  /** Last bid; null when no quote was seen. Spread veto fail-opens. */
  bid: number | null;
  /** Last ask; null when no quote was seen. Spread veto fail-opens. */
  ask: number | null;
  /**
   * Signed volume share on the impulse minute, (buy−sell)/(buy+sell).
   * Null when no classified prints — tape veto fail-opens.
   */
  tapeDelta: number | null;
  /** Top-of-book bid share; diagnostic, never a gate. */
  imbalance: number | null;
}

export interface OpeningDriveOptions {
  /** Inclusive window bounds in minutes since NY midnight. */
  windowStartMinutes: number;
  windowEndMinutes: number;
  minRvol1m: number;
  /** Max tolerated distance above session VWAP. */
  maxExtensionPct: number;
  rvolBaselineBars: number;
  /**
   * Break-bar volume must be at least this multiple of the first-minute volume
   * when 1-min RVOL is unavailable or short.
   */
  minOrbVolumeMultiple: number;
  /** Impulse close location (close−low)/(high−low); upper tertile = 2/3. */
  minCloseLocation: number;
  /**
   * (ask−bid)/mid. Applied only when both sides are present. Crossed markets
   * fail the gate.
   */
  maxSpreadPct: number;
  /** Tape delta must be strictly greater than this when classified prints exist. */
  minTapeDelta: number;
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
    spreadPct: partial.spreadPct ?? null,
    closeLocation: partial.closeLocation ?? null,
    tapeDelta: partial.tapeDelta ?? null,
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

/** Close location in the bar range. Null when the bar has no range (doji). */
export function computeCloseLocation(bar: BarData): number | null {
  const range = bar.high - bar.low;
  if (!(range > 0)) return null;
  return (bar.close - bar.low) / range;
}

/**
 * Relative spread. Null when a side is missing. Crossed quotes return 1 so
 * the veto fires — they are not tradable.
 */
export function computeSpreadPct(bid: number | null, ask: number | null): number | null {
  if (bid === null || ask === null || !(bid > 0) || !(ask > 0)) return null;
  if (ask < bid) return 1;
  const mid = (bid + ask) / 2;
  if (!(mid > 0)) return null;
  return (ask - bid) / mid;
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

  if (rangeBar === null || rangeBar.high <= 0) return reject('orb_not_ready');
  if (impulseBar.timestamp === rangeBar.timestamp) return reject('orb_not_ready');

  if (price <= sessionOpen) return reject('open_broken');

  const rvol1m = computeOneMinuteRvol(ctx.oneMinBars, opts.rvolBaselineBars);
  const closeLocation = computeCloseLocation(impulseBar);
  const spreadPct = computeSpreadPct(ctx.bid, ctx.ask);
  const { imbalance, tapeDelta } = ctx;
  const extensionPct = (price - sessionVwap) / sessionVwap;
  const observed = {
    extensionPct,
    rvol1m,
    imbalance,
    spreadPct,
    closeLocation,
    tapeDelta,
    entryPrice: price,
  };

  if (price <= rangeBar.high) return reject('no_breakout', observed);

  const vsRange = computeOrbVolumeMultiple(impulseBar.volume, rangeBar.volume);
  const hasRvolSurge = rvol1m !== null && rvol1m > opts.minRvol1m;
  const hasOrbVolumeSurge =
    vsRange !== null && vsRange >= opts.minOrbVolumeMultiple;
  if (!hasRvolSurge && !hasOrbVolumeSurge) {
    return reject('no_momentum', observed);
  }

  if (closeLocation === null || closeLocation < opts.minCloseLocation) {
    return reject('no_impulse_body', observed);
  }

  if (tapeDelta !== null && !(tapeDelta > opts.minTapeDelta)) {
    return reject('adverse_tape', observed);
  }

  if (spreadPct !== null && spreadPct > opts.maxSpreadPct) {
    return reject('wide_spread', observed);
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
    spreadPct,
    closeLocation,
    tapeDelta,
    entryPrice: price,
    stopPrice,
    score,
  };
}

/**
 * `outside_window` fires on every bar of the session. Everything else is a
 * real funnel step and is logged once per symbol per code.
 */
export function isOpeningDriveFunnelRejection(
  rejection: OpeningDriveRejection | null,
): rejection is OpeningDriveRejection {
  return rejection !== null && rejection !== 'outside_window';
}

export function describeOpeningDriveDecision(decision: OpeningDriveDecision): string {
  const pct = (value: number | null, digits: number): string =>
    value === null ? 'N/A' : `${(value * 100).toFixed(digits)}%`;

  const parts = [
    `ext ${pct(decision.extensionPct, 2)}`,
    `rvol1m ${decision.rvol1m === null ? 'N/A' : `${decision.rvol1m.toFixed(2)}x`}`,
    `loc ${decision.closeLocation === null ? 'N/A' : decision.closeLocation.toFixed(2)}`,
    `spread ${pct(decision.spreadPct, 2)}`,
    `tape ${decision.tapeDelta === null ? 'N/A' : decision.tapeDelta.toFixed(2)}`,
  ];
  if (decision.stopPrice !== null) parts.push(`stop $${decision.stopPrice.toFixed(2)}`);
  return parts.join(' | ');
}
