import type { BarData, SpyTrend } from './types';

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

/** Minutes since local midnight for an EST wall-clock Date from getESTDate(). */
export function minutesSinceMidnight(est: Date): number {
  return est.getHours() * 60 + est.getMinutes();
}

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
