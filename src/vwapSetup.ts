import { minutesSinceMidnight } from './utils';
import type { BarData, SpyTrend } from './types';

// Re-exported so strategy modules keep a single import surface for setup helpers.
export { minutesSinceMidnight };

export interface EntryWindowBounds {
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
}

export interface OhcBar {
  open: number;
  close: number;
}

/**
 * Live setup eligibility by universe membership.
 *
 * Hyper-Growth runs V7 Core VWAP pullback on every monitored name. ORB stays
 * Play-Maker only. Gating Core on `isOrbUniverse` silenced VWAP whenever the
 * evening screener is off (the whole list is V2).
 */
export function liveSetupGates(inOrbUniverse: boolean): {
  orb: boolean;
  vwapPullback: boolean;
} {
  return {
    orb: inOrbUniverse,
    vwapPullback: true,
  };
}

/**
 * Core V1 gates that Hyper-Growth VWAP must not inherit. Continuation buys
 * strength away from support: Fibonacci proximity, a SPY-bearish hard ban,
 * and the 3% VWAP-distance cap would empty the 10:00 funnel.
 * RSI exhaustion still applies at execution.
 */
export const VWAP_HYPER_GROWTH_GATES = {
  skipFibonacci: true,
  applySpyBearishBan: false,
  applyVwapDistanceCap: false,
} as const;

/**
 * V7 Core entry window: startInclusive <= now < endExclusive (EST).
 * Defaults: 10:00 <= t < 11:30.
 */
export function isVwapPullbackEntryWindow(
  est: Date,
  bounds: EntryWindowBounds,
): boolean {
  const mins = minutesSinceMidnight(est);
  const start = bounds.startHour * 60 + bounds.startMinute;
  const end = bounds.endHour * 60 + bounds.endMinute;
  return mins >= start && mins < end;
}

/** True when |price - vwap| / vwap <= tolPct. */
export function isNearVwap(price: number, vwap: number, tolPct: number): boolean {
  if (vwap <= 0 || tolPct < 0) return false;
  return Math.abs(price - vwap) / vwap <= tolPct;
}

/**
 * True when the tracked high has extended at least `minExtensionPct` above VWAP.
 * A VWAP hug (cross of a few bps, never leaving the line) fails this gate.
 */
export function hasImpulseExtension(
  localHigh: number,
  vwap: number,
  minExtensionPct: number,
): boolean {
  if (vwap <= 0 || minExtensionPct < 0) return false;
  return (localHigh - vwap) / vwap >= minExtensionPct;
}

/**
 * Gap-down name that also lagged the benchmark by more than `alphaFloor`
 * (e.g. -10%). Fail-open when either input is missing so a V2/ORB path
 * without screener alpha is not blocked here.
 */
export function isVwapLagger(
  gap: number | null | undefined,
  relativeReturn: number | null | undefined,
  alphaFloor: number,
): boolean {
  if (gap === null || gap === undefined) return false;
  if (relativeReturn === null || relativeReturn === undefined) return false;
  return gap < 0 && relativeReturn < alphaFloor;
}

function averagePositive(values: number[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  if (sum <= 0) return null;
  return sum / values.length;
}

/**
 * Dry-up: average pullback volume < ratio × average impulse volume.
 * Requires at least one bar in each series with positive total volume.
 */
export function hasVolumeDryUp(
  pullbackVolumes: number[],
  impulseVolumes: number[],
  ratio: number,
): boolean {
  const pullAvg = averagePositive(pullbackVolumes);
  const impulseAvg = averagePositive(impulseVolumes);
  if (pullAvg === null || impulseAvg === null) return false;
  return pullAvg < ratio * impulseAvg;
}

/** Green bar (close > open) with RVOL strictly above minRvol. */
export function isGreenBarWithRvol(
  bar: OhcBar,
  rvol: number | null,
  minRvol: number,
): boolean {
  if (rvol === null) return false;
  return bar.close > bar.open && rvol > minRvol;
}

/** Hard ban when SPY 5m trend is bearish. */
export function shouldHardBanSpyBearish(spyTrend: SpyTrend): boolean {
  return spyTrend === 'bearish';
}

/** Convenience: extract volumes from bars (last N including end). */
export function volumesFromBars(bars: BarData[], count: number): number[] {
  if (count < 1 || bars.length === 0) return [];
  return bars.slice(-count).map(b => b.volume);
}
