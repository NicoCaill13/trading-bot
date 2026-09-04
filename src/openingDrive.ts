/**
 * Opening Drive — pure decision logic, no I/O, no state.
 *
 * Two entry styles share this function (Open/Closed via options, not a fork):
 * - `orb_breakout` (scanner off): buy the first-minute high with volume + loc.
 * - `scanner_hold`: enter after the RTH impulse, still above the open, inside
 *   the open-extension band, not glued to the running session high.
 *
 * Quotes veto a wide spread (fail open when missing). Yesterday's close is
 * diagnostic. Snapshot IEX imbalance is diagnostic only.
 * The caller owns session state; this module only judges a snapshot.
 */

import { computeSessionImpulseHigh } from './openingRange';
import {
  computeOpeningExtensionPct,
  isOpeningExtensionInBand,
} from './screenerMath';
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
  /** True when the symbol is in the live opening-extension ranking. */
  inScanner?: boolean;
  /**
   * Max 1-min high since 09:30. Live path supplies an accumulator because the
   * rolling 1-min history is truncated. Tests may omit it — derived from
   * `oneMinBars` + `rangeBar`.
   */
  sessionHigh?: number | null;
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
  /**
   * Scanner-hold path: refuse names that are not in the current ranking.
   * Default false — premarket-watchlist rollback.
   */
  requireScannerMember?: boolean;
  /**
   * ORB path: last must clear the first-minute high. Default true.
   * Scanner-hold sets this false — that break is the FOMO wick.
   */
  requireBreakout?: boolean;
  /**
   * Scanner-hold: refuse last >= running RTH high (glued to the impulse wick).
   * That high is often 09:31–09:33, not the 09:30 print. Default false.
   */
  rejectAtOrHigh?: boolean;
  /** Inclusive floor on (last − sessionOpen) / sessionOpen. Default 0 (off). */
  minOpenExtensionPct?: number;
  /** Inclusive cap on (last − sessionOpen) / sessionOpen. Default off. */
  maxOpenExtensionPct?: number;
  /** Scanner-hold: last must be strictly above session VWAP. Default false. */
  requireAboveVwap?: boolean;
  /** ORB path: RVOL or first-minute volume multiple. Default true. */
  requireMomentum?: boolean;
  /** ORB path: impulse close in the upper tertile. Default true. */
  requireImpulseBody?: boolean;
  /** ORB path: signed-tape veto when prints exist. Default true. */
  requireTape?: boolean;
}

/**
 * Gates that turn ORB breakout into the scanner-hold continuation.
 * Band bounds stay in config — this overlay is the style switch only.
 */
export const SCANNER_HOLD_GATES: Pick<
  OpeningDriveOptions,
  | 'requireScannerMember'
  | 'requireBreakout'
  | 'rejectAtOrHigh'
  | 'requireAboveVwap'
  | 'requireMomentum'
  | 'requireImpulseBody'
  | 'requireTape'
> = {
  requireScannerMember: true,
  requireBreakout: false,
  rejectAtOrHigh: true,
  requireAboveVwap: true,
  requireMomentum: false,
  requireImpulseBody: false,
  requireTape: false,
};

/**
 * Ranking score in dollars of tape, not share count. Equal dollar flow at $6
 * and $95 must rank equal before ticket-efficiency is applied at enqueue.
 */
export function computeOpeningDriveScore(input: {
  impulseVolume: number;
  impulseClose: number;
  edgePct: number;
  volumeConviction: number;
}): number {
  const { impulseVolume, impulseClose, edgePct, volumeConviction } = input;
  if (!(impulseVolume > 0) || !(impulseClose > 0) || edgePct <= 0 || !(volumeConviction > 0)) {
    return 0;
  }
  return impulseVolume * impulseClose * edgePct * volumeConviction;
}

/** last glued to or above the session impulse high — the FOMO wick, not a hold. */
export function isChasingOpeningRangeHigh(last: number, sessionHigh: number): boolean {
  return last >= sessionHigh;
}

function chaseReferenceHigh(
  ctx: OpeningDriveContext,
  rangeBar: BarData,
): number {
  if (ctx.sessionHigh != null && ctx.sessionHigh > 0) return ctx.sessionHigh;
  return computeSessionImpulseHigh(ctx.oneMinBars, rangeBar) ?? rangeBar.high;
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

  if (opts.requireScannerMember === true && ctx.inScanner !== true) {
    return reject('not_in_scanner');
  }

  const { sessionOpen, sessionVwap, impulseBar, rangeBar } = ctx;
  if (sessionOpen === null || sessionOpen <= 0) return reject('insufficient_data');
  if (sessionVwap === null || sessionVwap <= 0) return reject('insufficient_data');

  const price = impulseBar.close;
  if (price <= 0) return reject('insufficient_data');

  if (rangeBar === null || rangeBar.high <= 0) return reject('orb_not_ready');
  if (impulseBar.timestamp === rangeBar.timestamp) return reject('orb_not_ready');

  if (price <= sessionOpen) return reject('open_broken');

  const requireBreakout = opts.requireBreakout !== false;
  const requireMomentum = opts.requireMomentum !== false;
  const requireImpulseBody = opts.requireImpulseBody !== false;
  const requireTape = opts.requireTape !== false;
  const minOpenExt = opts.minOpenExtensionPct ?? 0;
  const maxOpenExt = opts.maxOpenExtensionPct;

  const rvol1m = computeOneMinuteRvol(ctx.oneMinBars, opts.rvolBaselineBars);
  const closeLocation = computeCloseLocation(impulseBar);
  const spreadPct = computeSpreadPct(ctx.bid, ctx.ask);
  const { imbalance, tapeDelta } = ctx;
  const extensionPct = (price - sessionVwap) / sessionVwap;
  const openExtensionPct = computeOpeningExtensionPct(price, sessionOpen);
  const observed = {
    extensionPct,
    rvol1m,
    imbalance,
    spreadPct,
    closeLocation,
    tapeDelta,
    entryPrice: price,
  };

  const bandMax = maxOpenExt ?? Number.POSITIVE_INFINITY;
  if (
    (minOpenExt > 0 || maxOpenExt !== undefined) &&
    !isOpeningExtensionInBand(openExtensionPct, minOpenExt, bandMax)
  ) {
    if (openExtensionPct !== null && maxOpenExt !== undefined && openExtensionPct > maxOpenExt) {
      return reject('extension_too_high', observed);
    }
    return reject('extension_too_low', observed);
  }

  if (
    opts.rejectAtOrHigh === true &&
    isChasingOpeningRangeHigh(price, chaseReferenceHigh(ctx, rangeBar))
  ) {
    return reject('chasing_open_high', observed);
  }

  if (opts.requireAboveVwap === true && !(price > sessionVwap)) {
    return reject('below_vwap', observed);
  }

  if (requireBreakout && price <= rangeBar.high) {
    return reject('no_breakout', observed);
  }

  const vsRange = computeOrbVolumeMultiple(impulseBar.volume, rangeBar.volume);
  const hasRvolSurge = rvol1m !== null && rvol1m > opts.minRvol1m;
  const hasOrbVolumeSurge =
    vsRange !== null && vsRange >= opts.minOrbVolumeMultiple;
  if (requireMomentum && !hasRvolSurge && !hasOrbVolumeSurge) {
    return reject('no_momentum', observed);
  }

  if (requireImpulseBody && (closeLocation === null || closeLocation < opts.minCloseLocation)) {
    return reject('no_impulse_body', observed);
  }

  if (requireTape && tapeDelta !== null && !(tapeDelta > opts.minTapeDelta)) {
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
  const edgePct = requireBreakout
    ? Math.max(breakPct, 0)
    : Math.max(openExtensionPct ?? 0, 0);
  const score = computeOpeningDriveScore({
    impulseVolume: impulseBar.volume,
    impulseClose: price,
    edgePct,
    volumeConviction,
  });

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
