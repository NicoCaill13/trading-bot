/**
 * Opening Drive entry path (#29) — pure decision logic, no I/O, no state.
 *
 * Arms only on symbols the screener tagged `isStraightRun`: names that grind up
 * daily without offering the VWAP pullback Core V7 waits for. Everything Core
 * relies on (pullback tracking, Fibonacci support, VWAP proximity) is absent
 * here by design — this path buys continuation, not mean reversion.
 *
 * The caller owns all session state; this module only judges a snapshot.
 */

import type { BarData, OpeningDriveDecision, OpeningDriveRejection } from './types';

export interface OpeningDriveContext {
  symbol: string;
  /** Minutes since NY midnight for the impulse bar's own timestamp. */
  barMinutesSinceMidnight: number;
  isStraightRun: boolean;
  /** 0..1 quality of the daily run, used to rank competing candidates. */
  straightRunScore: number;
  /** Previous session close, from the screener snapshot. */
  previousClose: number | null;
  /** Open of the first regular-session 1-min bar of the day. */
  sessionOpen: number | null;
  /** Session VWAP — the anti-chase reference; required to reach a decision. */
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
  /** Max tolerated distance above session VWAP, not above the session open. */
  maxExtensionPct: number;
  rvolBaselineBars: number;
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
    stopPrice: partial.stopPrice ?? null,
    score: 0,
  };
}

/**
 * Volume of the impulse bar over the mean of the bars preceding it.
 *
 * Deliberately not reusing the 5-minute RVOL helper: that one runs on a 5-bar
 * baseline suited to the Core path, which on 1-minute data would be a 5-minute
 * reference — far too short to tell an opening drive from ordinary noise.
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

/**
 * Checks run cheapest-first, with one hard constraint: `max_extension` is last.
 * Shadow mode counts setups carrying that code to decide whether the anti-chase
 * cap is rejecting winners, so the code must mean "only the cap stopped this".
 */
export function evaluateOpeningDrive(
  ctx: OpeningDriveContext,
  opts: OpeningDriveOptions,
): OpeningDriveDecision {
  if (!ctx.isStraightRun) return reject('not_straight_run');

  const { barMinutesSinceMidnight: minutes } = ctx;
  if (minutes < opts.windowStartMinutes || minutes > opts.windowEndMinutes) {
    return reject('outside_window');
  }

  const { sessionOpen, sessionVwap, impulseBar } = ctx;
  if (sessionOpen === null || sessionOpen <= 0) return reject('insufficient_data');
  if (sessionVwap === null || sessionVwap <= 0) return reject('insufficient_data');

  const price = impulseBar.close;
  if (price <= 0) return reject('insufficient_data');

  // The tag was earned on yesterday's closes. An open below that close means the
  // run is already broken, so the tag is stale and must not arm anything.
  if (ctx.previousClose !== null && sessionOpen < ctx.previousClose) {
    return reject('gap_down');
  }

  // Holding above either reference is enough: a name that gapped up and drifted
  // under its open can still be leading if it sits above session VWAP.
  if (price <= sessionOpen && price <= sessionVwap) return reject('open_broken');

  const rvol1m = computeOneMinuteRvol(ctx.oneMinBars, opts.rvolBaselineBars);
  const imbalance = ctx.imbalance;
  // Measured against VWAP, not the session open. An open-anchored cap grows
  // stale by construction: the window starts 15 minutes after the open, which on
  // a genuine drive is long enough to clear any tight cap, so the cap would
  // reject exactly the moves this path exists to take. VWAP rises with the
  // drive, which keeps the guard meaningful at any point in the window.
  const extensionPct = (price - sessionVwap) / sessionVwap;
  const observed = { extensionPct, rvol1m, imbalance };

  const hasVolumeSurge = rvol1m !== null && rvol1m > opts.minRvol1m;
  const hasBuyPressure = imbalance !== null && imbalance >= opts.minImbalance;
  if (!hasVolumeSurge && !hasBuyPressure) return reject('no_momentum', observed);

  const stopPrice = impulseBar.low;
  if (!(stopPrice > 0) || stopPrice >= price) {
    return reject('no_stop_reference', observed);
  }

  if (extensionPct > opts.maxExtensionPct) {
    return reject('max_extension', { ...observed, stopPrice });
  }

  // Volume-weighted conviction, same magnitude family as the ORB score so both
  // Satellite paths remain comparable if they ever land in the same flush.
  const conviction = Math.max(0, (rvol1m ?? 1) - 1);
  const score = impulseBar.volume * conviction * Math.max(ctx.straightRunScore, 0.1);

  return {
    armed: true,
    rejection: null,
    extensionPct,
    rvol1m,
    imbalance,
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
