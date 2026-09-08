/**
 * Historical reconstruction of the live opening-extension scanner.
 *
 * Mirrors `rankOpeningMovers` + eligible-pool gates so a replay can refuse
 * names that were not in the top-N at that minute. Not used by the live bot.
 */

import config from '../../src/config';
import { rankOpeningMovers, type OpeningMover } from '../../src/openingScanner';
import {
  computeOpeningExtensionPct,
  passesDollarVolume,
  passesPremarketPricePair,
} from '../../src/screenerMath';
import { toESTDate } from '../../src/utils';
import type { RawBar } from './barFetch';

export interface PoolName {
  symbol: string;
  previousClose: number;
  prevDollarVolume: number;
}

export interface ScannerMembership {
  /** Top-N symbols at each minute since NY midnight. */
  atMinute: ReadonlyMap<number, ReadonlySet<string>>;
  /** Union of every minute's top-N — the only names that need a full-day tape. */
  union: readonly string[];
}

export function barMinutes(timestamp: string): number {
  const est = toESTDate(new Date(timestamp));
  return est.getHours() * 60 + est.getMinutes();
}

export function lastDailyBefore(
  bars: readonly RawBar[],
  cutoffMs: number,
): { close: number; volume: number } | null {
  let found: RawBar | null = null;
  for (const bar of bars) {
    if (Date.parse(bar.t) >= cutoffMs) break;
    found = bar;
  }
  if (found === null || !(found.c > 0)) return null;
  return { close: found.c, volume: found.v };
}

export function buildEligiblePool(
  symbols: readonly string[],
  dailyBars: ReadonlyMap<string, readonly RawBar[]>,
  cutoffMs: number,
  opts: {
    minPrice: number;
    maxPrice: number;
    minPrevDollarVolume: number;
    maxSize: number;
  },
): PoolName[] {
  const pool: PoolName[] = [];
  for (const symbol of symbols) {
    const prev = lastDailyBefore(dailyBars.get(symbol) ?? [], cutoffMs);
    if (prev === null) continue;
    if (!passesPremarketPricePair(prev.close, prev.close, opts.minPrice, opts.maxPrice)) {
      continue;
    }
    if (!passesDollarVolume(prev.close, prev.volume, opts.minPrevDollarVolume)) continue;
    pool.push({
      symbol,
      previousClose: prev.close,
      prevDollarVolume: prev.close * prev.volume,
    });
  }
  pool.sort((a, b) => b.prevDollarVolume - a.prevDollarVolume);
  return pool.slice(0, opts.maxSize);
}

export function moverAtSnapshot(
  symbol: string,
  bars: readonly RawBar[],
  previousClose: number,
  snapshotMinutes: number,
  marketOpenMinutes: number,
): OpeningMover | null {
  const inWindow = bars.filter(b => {
    const mins = barMinutes(b.t);
    return mins >= marketOpenMinutes && mins <= snapshotMinutes;
  });
  if (inWindow.length === 0) return null;
  const sessionOpen = inWindow[0].o;
  const last = inWindow[inWindow.length - 1].c;
  const extensionPct = computeOpeningExtensionPct(last, sessionOpen);
  if (extensionPct === null) return null;
  const rthShares = inWindow.reduce((sum, b) => sum + b.v, 0);
  return {
    symbol,
    last,
    sessionOpen,
    previousClose,
    rthDollarVolume: last * rthShares,
    extensionPct,
  };
}

export function rankScannerAtMinute(
  symbols: readonly string[],
  oneMin: ReadonlyMap<string, readonly RawBar[]>,
  prevClose: ReadonlyMap<string, number>,
  snapshotMinutes: number,
  marketOpenMinutes: number,
): string[] {
  const od = config.openingDrive;
  const hits: OpeningMover[] = [];
  for (const symbol of symbols) {
    const previousClose = prevClose.get(symbol);
    if (previousClose === undefined) continue;
    const mover = moverAtSnapshot(
      symbol,
      oneMin.get(symbol) ?? [],
      previousClose,
      snapshotMinutes,
      marketOpenMinutes,
    );
    if (mover !== null) hits.push(mover);
  }

  return rankOpeningMovers(hits, {
    minPrice: config.screener.minClosePrice,
    maxPrice: config.screener.maxClosePrice,
    minExtensionPct: od.scannerMinExtensionPct,
    minRthDollarVolume: od.scannerMinRthDollarVolume,
    maxSymbols: od.scannerMaxSymbols,
    pinned: new Set(),
  }).map(m => m.symbol);
}

/**
 * One top-N set per minute in [windowStart, windowEnd], matching the live
 * 60s refresh. A signal at minute T is in-scanner only if the symbol is in
 * `atMinute.get(T)`.
 */
export function buildScannerMembership(
  symbols: readonly string[],
  oneMin: ReadonlyMap<string, readonly RawBar[]>,
  prevClose: ReadonlyMap<string, number>,
  windowStartMinutes: number,
  windowEndMinutes: number,
  marketOpenMinutes: number,
): ScannerMembership {
  const atMinute = new Map<number, ReadonlySet<string>>();
  const union = new Set<string>();

  for (let minute = windowStartMinutes; minute <= windowEndMinutes; minute++) {
    const ranked = rankScannerAtMinute(
      symbols,
      oneMin,
      prevClose,
      minute,
      marketOpenMinutes,
    );
    atMinute.set(minute, new Set(ranked));
    for (const symbol of ranked) union.add(symbol);
  }

  return { atMinute, union: [...union] };
}
