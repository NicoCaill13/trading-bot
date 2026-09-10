/**
 * Gap Hold — pure decision logic, no I/O, no state.
 *
 * Two tracks share one hold confirmation (Open/Closed via context.track):
 * - `news_gap`: overnight gap vs previous close, catalyst already filtered
 *   upstream. CHPT/SIG/IRD: the gap must still be intact after the first
 *   minutes, not a 2.5–5.5% open-extension band.
 * - `continuation`: yesterday closed strong and today is still holding above
 *   the open, preferably through yesterday's high. AEHR/SNDK.
 *
 * The caller owns scanner membership, news, and session state.
 */

import { computeSessionImpulseLow } from './openingRange';
import { computeOvernightGapPct } from './screenerMath';
import { computeSpreadPct } from './openingDrive';
import type {
  BarData,
  GapHoldDecision,
  GapHoldRejection,
  GapHoldTrack,
} from './types';

export interface GapHoldContext {
  symbol: string;
  barMinutesSinceMidnight: number;
  rangeBar: BarData | null;
  previousClose: number | null;
  previousHigh: number | null;
  sessionOpen: number | null;
  sessionVwap: number | null;
  impulseBar: BarData;
  oneMinBars: readonly BarData[];
  bid: number | null;
  ask: number | null;
  inScanner?: boolean;
  track: GapHoldTrack | null;
  catalystPasses: boolean | null;
}

export interface GapHoldOptions {
  windowStartMinutes: number;
  windowEndMinutes: number;
  minOvernightGapPct: number;
  maxOvernightGapPct: number;
  continuationMaxGapPct: number;
  gapFillTolerancePct: number;
  maxSpreadPct: number;
  hardStopFloorPct: number;
  requireScannerMember: boolean;
  requireAboveVwap: boolean;
}

function reject(
  rejection: GapHoldRejection,
  partial: Partial<GapHoldDecision> = {},
): GapHoldDecision {
  return {
    armed: false,
    rejection,
    track: partial.track ?? null,
    overnightGapPct: partial.overnightGapPct ?? null,
    extensionPct: partial.extensionPct ?? null,
    spreadPct: partial.spreadPct ?? null,
    entryPrice: partial.entryPrice ?? null,
    stopPrice: partial.stopPrice ?? null,
    score: 0,
  };
}

/**
 * Dollar-flow score so a $9 15×-volume gapper outranks a $90 drift.
 */
export function computeGapHoldScore(input: {
  impulseVolume: number;
  impulseClose: number;
  overnightGapPct: number;
  track: GapHoldTrack;
}): number {
  const { impulseVolume, impulseClose, overnightGapPct, track } = input;
  if (!(impulseVolume > 0) || !(impulseClose > 0)) return 0;
  const gapWeight = Math.max(overnightGapPct, 0);
  const trackWeight = track === 'news_gap' ? 1 : 0.6;
  return impulseVolume * impulseClose * gapWeight * trackWeight;
}

export function isGapHoldFunnelRejection(
  rejection: GapHoldRejection | null,
): rejection is GapHoldRejection {
  return rejection !== null && rejection !== 'outside_window';
}

export function describeGapHoldDecision(decision: GapHoldDecision): string {
  const pct = (value: number | null, digits: number): string =>
    value === null ? 'N/A' : `${(value * 100).toFixed(digits)}%`;
  const parts = [
    decision.track ?? 'no-track',
    `gap ${pct(decision.overnightGapPct, 1)}`,
    `vwap ${pct(decision.extensionPct, 2)}`,
    `spread ${pct(decision.spreadPct, 2)}`,
  ];
  if (decision.stopPrice !== null) parts.push(`stop $${decision.stopPrice.toFixed(2)}`);
  return parts.join(' | ');
}

export function evaluateGapHold(
  ctx: GapHoldContext,
  opts: GapHoldOptions,
): GapHoldDecision {
  const { barMinutesSinceMidnight: minutes } = ctx;
  if (minutes < opts.windowStartMinutes || minutes > opts.windowEndMinutes) {
    return reject('outside_window');
  }

  if (opts.requireScannerMember && ctx.inScanner !== true) {
    return reject('not_in_scanner');
  }

  const { sessionOpen, sessionVwap, impulseBar, rangeBar, track } = ctx;
  if (sessionOpen === null || sessionOpen <= 0) return reject('insufficient_data');
  if (sessionVwap === null || sessionVwap <= 0) return reject('insufficient_data');
  if (ctx.previousClose === null || ctx.previousClose <= 0) {
    return reject('insufficient_data');
  }
  if (rangeBar === null || rangeBar.high <= 0) return reject('insufficient_data');
  if (impulseBar.timestamp === rangeBar.timestamp) return reject('insufficient_data');
  if (track === null) return reject('not_in_scanner');

  const price = impulseBar.close;
  if (!(price > 0)) return reject('insufficient_data');

  const overnightGapPct = computeOvernightGapPct(sessionOpen, ctx.previousClose);
  const extensionPct = (price - sessionVwap) / sessionVwap;
  const spreadPct = computeSpreadPct(ctx.bid, ctx.ask);
  const observed: Partial<GapHoldDecision> = {
    track,
    overnightGapPct,
    extensionPct,
    spreadPct,
    entryPrice: price,
  };

  if (!(price >= sessionOpen)) return reject('open_broken', observed);

  if (overnightGapPct === null) return reject('insufficient_data', observed);

  if (track === 'news_gap') {
    if (
      overnightGapPct < opts.minOvernightGapPct ||
      overnightGapPct > opts.maxOvernightGapPct
    ) {
      return reject('gap_out_of_band', observed);
    }
    if (ctx.catalystPasses !== true) return reject('no_catalyst', observed);
  } else {
    if (overnightGapPct > opts.continuationMaxGapPct) {
      return reject('gap_out_of_band', observed);
    }
    const previousHigh = ctx.previousHigh;
    const gappedThrough = previousHigh !== null && sessionOpen > previousHigh;
    const brokeRange = previousHigh !== null && price > previousHigh;
    if (!gappedThrough && !brokeRange) return reject('no_breakout', observed);
  }

  const sessionLow = computeSessionImpulseLow(ctx.oneMinBars, rangeBar);
  const fillLine = sessionOpen * (1 - opts.gapFillTolerancePct);
  if (sessionLow !== null && sessionLow < fillLine) {
    return reject('gap_filled', observed);
  }

  if (opts.requireAboveVwap && !(price > sessionVwap)) {
    return reject('below_vwap', observed);
  }

  if (spreadPct !== null && spreadPct > opts.maxSpreadPct) {
    return reject('wide_spread', observed);
  }

  const floorStop = price * (1 - opts.hardStopFloorPct);
  const structuralStop = sessionLow !== null && sessionLow < price
    ? sessionLow
    : impulseBar.low;
  const stopPrice = Math.min(
    structuralStop > 0 ? structuralStop : floorStop,
    floorStop,
  );

  return {
    armed: true,
    rejection: null,
    track,
    overnightGapPct,
    extensionPct,
    spreadPct,
    entryPrice: price,
    stopPrice,
    score: computeGapHoldScore({
      impulseVolume: impulseBar.volume,
      impulseClose: price,
      overnightGapPct,
      track,
    }),
  };
}
