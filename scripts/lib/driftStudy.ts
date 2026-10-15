/**
 * Pure maths for the multi-day drift study: after a catalyst-like session, does
 * a name keep moving for days in a way a cash T+1 account could trade?
 *
 * Timing is fixed to what is knowable: the event is read from the finished
 * session E, the position is bought at the open of E+1 and sold at the close of
 * E+horizon. Nothing from E+1 onward informs the selection.
 *
 * No I/O and no config: every threshold is injected, so each rule is testable.
 */

import type { RawBar } from './barFetch';

/** Sessions of history a context needs (the volume average and the 20-day high). */
export const CONTEXT_LOOKBACK = 20;
/** Calendar-session span the lookback may cover before it counts as stale data. */
const MAX_LOOKBACK_SESSION_SPAN = 30;

/** Holding periods, in sessions, counted from the entry open (1 = open to close of E+1). */
export const DRIFT_HORIZONS: readonly number[] = [1, 3, 5, 10];

/** Maps a bar timestamp to its index in the trading calendar, or undefined if outside it. */
export type SessionOf = (timestamp: string) => number | undefined;

export interface DailyContext {
  /** Open versus the previous close, in percent. */
  gapPct: number;
  /** Session volume over its trailing average. */
  volumeRatio: number;
  /** Close versus the same session's open, in percent: did the move hold. */
  closeVsOpenPct: number;
  /** Close at or above the highest high of the lookback. */
  breaksHigh20: boolean;
}

/**
 * Context of session `i`, from adjusted bars. Null when the history is too thin
 * or has holes: a missing session would silently stretch the lookback or the
 * holding period.
 */
export function computeDailyContext(
  bars: readonly RawBar[],
  i: number,
  sessionOf: SessionOf,
): DailyContext | null {
  if (i < CONTEXT_LOOKBACK || i >= bars.length) return null;

  const today = bars[i];
  const previous = bars[i - 1];
  const sessionToday = sessionOf(today.t);
  const sessionPrevious = sessionOf(previous.t);
  const sessionStart = sessionOf(bars[i - CONTEXT_LOOKBACK].t);
  if (sessionToday === undefined || sessionPrevious === undefined || sessionStart === undefined) {
    return null;
  }
  if (sessionToday - sessionPrevious !== 1) return null;
  if (sessionToday - sessionStart > MAX_LOOKBACK_SESSION_SPAN) return null;
  if (!(previous.c > 0) || !(today.o > 0)) return null;

  let volumeSum = 0;
  let highestHigh = 0;
  for (let k = i - CONTEXT_LOOKBACK; k < i; k++) {
    volumeSum += bars[k].v;
    highestHigh = Math.max(highestHigh, bars[k].h);
  }
  const averageVolume = volumeSum / CONTEXT_LOOKBACK;
  if (!(averageVolume > 0)) return null;

  return {
    gapPct: ((today.o - previous.c) / previous.c) * 100,
    volumeRatio: today.v / averageVolume,
    closeVsOpenPct: ((today.c - today.o) / today.o) * 100,
    breaksHigh20: today.c >= highestHigh,
  };
}

/**
 * Return of buying the open of session i+1 and selling the close of session
 * i+horizon, in percent. Null unless every session in between is present, so
 * the index distance really is the holding period.
 */
export function forwardReturnPct(
  bars: readonly RawBar[],
  i: number,
  horizon: number,
  sessionOf: SessionOf,
): number | null {
  const entry = bars[i + 1];
  const exit = bars[i + horizon];
  if (entry === undefined || exit === undefined || horizon < 1) return null;

  const sessionEvent = sessionOf(bars[i].t);
  const sessionEntry = sessionOf(entry.t);
  const sessionExit = sessionOf(exit.t);
  if (sessionEvent === undefined || sessionEntry === undefined || sessionExit === undefined) {
    return null;
  }
  if (sessionEntry !== sessionEvent + 1 || sessionExit !== sessionEvent + horizon) return null;
  if (!(entry.o > 0)) return null;

  return ((exit.c - entry.o) / entry.o) * 100;
}

export interface PoolLimits {
  minPrice: number;
  maxPrice: number;
  minDollarVolume: number;
}

/** The live pool gate, on the previous session's raw close and dollar volume. */
export function passesPool(
  rawClose: number,
  rawDollarVolume: number,
  limits: PoolLimits,
): boolean {
  return (
    rawClose >= limits.minPrice &&
    rawClose <= limits.maxPrice &&
    rawDollarVolume >= limits.minDollarVolume
  );
}

/**
 * A named catalyst pattern, read from the finished session. Fixed before the
 * run: editing these after reading results turns the test into a fit.
 */
export interface DriftEvent {
  name: string;
  matches: (context: DailyContext) => boolean;
}

export const DRIFT_EVENTS: readonly DriftEvent[] = [
  {
    name: 'gap>=8 & vol>=3x & held',
    matches: c => c.gapPct >= 8 && c.volumeRatio >= 3 && c.closeVsOpenPct >= 0,
  },
  {
    name: 'gap>=8 & vol>=3x & faded',
    matches: c => c.gapPct >= 8 && c.volumeRatio >= 3 && c.closeVsOpenPct < 0,
  },
  {
    name: 'gap 4-8 & vol>=3x & held',
    matches: c =>
      c.gapPct >= 4 && c.gapPct < 8 && c.volumeRatio >= 3 && c.closeVsOpenPct >= 0,
  },
  {
    name: 'breakout20 & vol>=3x & gap<4',
    matches: c => c.breaksHigh20 && c.volumeRatio >= 3 && c.gapPct < 4,
  },
];

/** Sessions a symbol must wait before the same event can count again. */
export const EVENT_COOLDOWN_SESSIONS = 10;

/** Running sum and count of forward returns per horizon, for one session. */
export interface HorizonAccumulator {
  sum: number[];
  count: number[];
}

export function emptyAccumulator(): HorizonAccumulator {
  return {
    sum: DRIFT_HORIZONS.map(() => 0),
    count: DRIFT_HORIZONS.map(() => 0),
  };
}

/** Adds the returns of one pool name (null = not available at that horizon). */
export function accumulateReturns(
  acc: HorizonAccumulator,
  returns: readonly (number | null)[],
): void {
  returns.forEach((value, h) => {
    if (value === null) return;
    acc.sum[h] += value;
    acc.count[h] += 1;
  });
}

/** Mean forward return of the pool at a horizon index, or null when empty. */
export function accumulatorMean(acc: HorizonAccumulator, horizonIndex: number): number | null {
  return acc.count[horizonIndex] > 0 ? acc.sum[horizonIndex] / acc.count[horizonIndex] : null;
}
