/**
 * Bar-by-bar simulation of one Opening Drive trade, from signal to exit.
 *
 * Reuses the live decision function so the entry criteria cannot drift from
 * production. Everything after the signal is modelled here, deliberately on the
 * pessimistic side:
 *
 *  - Entry fills at the NEXT bar's open, never the signal bar's close. The live
 *    path debounces signals for SIGNAL_BATCH_WINDOW_MS and then makes ~10 REST
 *    calls before submitting, so the fill is always in the following minute.
 *  - Within a bar, the stop is tested before the high. A bar that touched both
 *    is scored as a loss, since 1-min bars do not say which came first.
 *  - Both legs pay the spread.
 */

import { evaluateOpeningDrive, type OpeningDriveContext, type OpeningDriveOptions } from '../../src/openingDrive';
import { minutesSinceMidnight } from '../../src/vwapSetup';
import { toESTDate } from '../../src/utils';
import type { BarData } from '../../src/types';

export type { OpeningDriveOptions };

export type SimExitReason = 'stop-loss' | 'trailing-stop' | 'time-stop' | 'hard-close';

export type SimRejection = 'anti_chase' | 'no_fill_bar' | 'qty_zero';

export interface SimOptions {
  /** One-way cost as a fraction of price, paid on entry and again on exit. */
  spreadPctOneWay: number;
  maxEntryChasePct: number;
  hardStopFloorPct: number;
  trailTriggerPct: number;
  trailPct: number;
  timeStopMinutes: number;
  /** Minutes since EST midnight at which any open position is flattened. */
  hardCloseMinutes: number;
}

export interface SimTrade {
  symbol: string;
  session: string;
  entryTime: string;
  entryPrice: number;
  qty: number;
  stopPrice: number;
  stopDistance: number;
  exitTime: string;
  exitPrice: number;
  exitReason: SimExitReason;
  /** Peak unrealized gain as a fraction of entry — drives the trail question. */
  mfePct: number;
  netPnl: number;
  riskDollars: number;
  pnlR: number;
  heldMinutes: number;
  /**
   * Bars missing from the 1-min sequence while the position was open. Micro-caps
   * hit LULD halts, and a halt reopen jumps straight past a resting stop, so a
   * non-zero count means the modelled fill is optimistic.
   */
  haltGapCount: number;
  /** Exit filled at a bar open already below the stop, i.e. the stop was jumped. */
  gappedThroughStop: boolean;
}

/** Minutes of missing 1-min bars that count as a probable trading halt. */
const HALT_GAP_MINUTES = 2;

export type SimOutcome =
  | { kind: 'trade'; trade: SimTrade }
  | { kind: 'no_signal' }
  | { kind: 'rejected'; reason: SimRejection };

export interface SignalCandidate {
  signalIndex: number;
  signalClose: number;
  stopPriceOverride: number;
}

function cumulativeVwap(bars: readonly BarData[]): number | null {
  const volume = bars.reduce((sum, b) => sum + b.volume, 0);
  if (volume <= 0) return null;
  const tpv = bars.reduce((sum, b) => sum + ((b.high + b.low + b.close) / 3) * b.volume, 0);
  return tpv / volume;
}

/**
 * First bar in the Opening Drive window that arms the setup.
 *
 * `rthBars` must start at the session open: bar 0 is the opening range and can
 * never be the impulse bar.
 */
export function findSignal(
  symbol: string,
  rthBars: readonly BarData[],
  previousClose: number | null,
  odOptions: OpeningDriveOptions,
): SignalCandidate | null {
  if (rthBars.length === 0) return null;

  const rangeBar = rthBars[0];
  const sessionOpen = rangeBar.open;
  const history: BarData[] = [];

  for (let i = 0; i < rthBars.length; i++) {
    const bar = rthBars[i];
    history.push(bar);

    const minutes = minutesSinceMidnight(toESTDate(new Date(bar.timestamp)));
    if (minutes > odOptions.windowEndMinutes) break;

    const ctx: OpeningDriveContext = {
      symbol,
      barMinutesSinceMidnight: minutes,
      rangeBar,
      previousClose,
      sessionOpen,
      sessionVwap: cumulativeVwap(history),
      impulseBar: bar,
      oneMinBars: history,
      bid: null,
      ask: null,
      tapeDelta: null,
      imbalance: null,
    };

    const decision = evaluateOpeningDrive(ctx, odOptions);
    if (decision.armed && decision.stopPrice !== null) {
      return {
        signalIndex: i,
        signalClose: bar.close,
        stopPriceOverride: decision.stopPrice,
      };
    }
  }

  return null;
}

/**
 * Plays a signal forward to its exit. `sizeQty` receives the resolved entry
 * price and stop distance so capital rules stay with the caller.
 */
export function simulateTrade(
  symbol: string,
  session: string,
  rthBars: readonly BarData[],
  signal: SignalCandidate,
  options: SimOptions,
  sizeQty: (entryPrice: number, stopDistance: number) => number,
): SimOutcome {
  const fillBar = rthBars[signal.signalIndex + 1];
  if (!fillBar) return { kind: 'rejected', reason: 'no_fill_bar' };

  const chasePct = ((fillBar.open - signal.signalClose) / signal.signalClose) * 100;
  if (chasePct > options.maxEntryChasePct) {
    return { kind: 'rejected', reason: 'anti_chase' };
  }

  const entryPrice = fillBar.open * (1 + options.spreadPctOneWay);
  const structuralDistance = entryPrice - signal.stopPriceOverride;
  const stopDistance = Math.max(
    structuralDistance,
    entryPrice * options.hardStopFloorPct,
  );
  if (stopDistance <= 0) return { kind: 'rejected', reason: 'qty_zero' };

  const qty = sizeQty(entryPrice, stopDistance);
  if (qty < 1) return { kind: 'rejected', reason: 'qty_zero' };

  const entryTime = fillBar.timestamp;
  const entryMs = Date.parse(entryTime);
  let stop = entryPrice - stopDistance;
  let hwm = entryPrice;
  let trailArmed = false;

  let exitPrice = fillBar.close;
  let exitTime = fillBar.timestamp;
  let exitReason: SimExitReason = 'hard-close';
  let haltGapCount = 0;
  let gappedThroughStop = false;

  for (let i = signal.signalIndex + 1; i < rthBars.length; i++) {
    const bar = rthBars[i];
    exitTime = bar.timestamp;

    const previous = rthBars[i - 1];
    const gapMinutes = (Date.parse(bar.timestamp) - Date.parse(previous.timestamp)) / 60_000;
    if (gapMinutes > HALT_GAP_MINUTES) haltGapCount++;

    // Gap through the stop: the fill is the open, not the stop price.
    if (bar.open <= stop) {
      exitPrice = bar.open;
      exitReason = trailArmed ? 'trailing-stop' : 'stop-loss';
      gappedThroughStop = true;
      break;
    }
    if (bar.low <= stop) {
      exitPrice = stop;
      exitReason = trailArmed ? 'trailing-stop' : 'stop-loss';
      break;
    }

    if (bar.high > hwm) hwm = bar.high;
    if (!trailArmed && hwm >= entryPrice * (1 + options.trailTriggerPct)) {
      trailArmed = true;
    }
    if (trailArmed) {
      stop = Math.max(stop, hwm * (1 - options.trailPct));
    }

    const elapsedMinutes = (Date.parse(bar.timestamp) - entryMs) / 60_000;
    const mfe = (hwm - entryPrice) / entryPrice;
    if (elapsedMinutes >= options.timeStopMinutes && mfe <= 0) {
      exitPrice = bar.close;
      exitReason = 'time-stop';
      break;
    }

    const minutes = minutesSinceMidnight(toESTDate(new Date(bar.timestamp)));
    if (minutes >= options.hardCloseMinutes) {
      exitPrice = bar.close;
      exitReason = 'hard-close';
      break;
    }

    exitPrice = bar.close;
  }

  const netExit = exitPrice * (1 - options.spreadPctOneWay);
  const netPnl = (netExit - entryPrice) * qty;
  const riskDollars = stopDistance * qty;

  return {
    kind: 'trade',
    trade: {
      symbol,
      session,
      entryTime,
      entryPrice,
      qty,
      stopPrice: entryPrice - stopDistance,
      stopDistance,
      exitTime,
      exitPrice: netExit,
      exitReason,
      mfePct: (hwm - entryPrice) / entryPrice,
      netPnl,
      riskDollars,
      pnlR: riskDollars > 0 ? netPnl / riskDollars : 0,
      heldMinutes: (Date.parse(exitTime) - entryMs) / 60_000,
      haltGapCount,
      gappedThroughStop,
    },
  };
}
