import path from 'path';
import config from './config';
import { readJson, writeJsonAtomic } from './jsonStore';
import type { SignalOrigin, Watchlist, WatchlistSymbol } from './types';

export function getSymbolOrigin(entry: WatchlistSymbol): SignalOrigin {
  if (entry.origin === 'V1_CORE' || entry.origin === 'V2_PLAYMAKER') {
    return entry.origin;
  }
  return entry.source === 'satellite' ? 'V2_PLAYMAKER' : 'V1_CORE';
}

export function isV2Symbol(entry: WatchlistSymbol): boolean {
  return getSymbolOrigin(entry) === 'V2_PLAYMAKER';
}

function isWatchlistShape(value: unknown): value is Watchlist {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record['generatedAt'] === 'string' && Array.isArray(record['symbols']);
}

export async function readWatchlist(): Promise<Watchlist | null> {
  const parsed = await readJson(path.resolve(config.paths.watchlist));
  return isWatchlistShape(parsed) ? parsed : null;
}

export async function writeWatchlist(watchlist: Watchlist): Promise<void> {
  await writeJsonAtomic(path.resolve(config.paths.watchlist), watchlist, { pretty: true });
}

/**
 * Merges V2 Play-Maker symbols into the daily watchlist without dropping V1 Core entries.
 * Preserves the Core `tradingDay` — a pre-market merge must not look like a fresh EOD run.
 */
export async function mergeV2IntoWatchlist(
  v2Symbols: WatchlistSymbol[],
): Promise<Watchlist> {
  const existing = await readWatchlist();
  const v1Symbols = (existing?.symbols ?? []).filter(s => !isV2Symbol(s));
  const coreSymbolSet = new Set(v1Symbols.map(s => s.symbol));

  const dedupedV2 = v2Symbols.filter(s => {
    if (coreSymbolSet.has(s.symbol)) return false;
    return true;
  });

  const watchlist: Watchlist = {
    generatedAt: existing?.generatedAt ?? new Date().toISOString(),
    tradingDay: existing?.tradingDay,
    benchmarkReturn: existing?.benchmarkReturn ?? null,
    universeSize: existing?.universeSize ?? dedupedV2.length,
    liquidFiltered: existing?.liquidFiltered ?? 0,
    symbols: [...v1Symbols, ...dedupedV2],
  };

  await writeWatchlist(watchlist);
  return watchlist;
}

export function extractV2Symbols(watchlist: Watchlist): WatchlistSymbol[] {
  return watchlist.symbols.filter(isV2Symbol);
}

/**
 * Hyper-Growth universe write: V2-only list stamped with the required EOD
 * trading day so `isWatchlistCurrent` accepts it for the next cash session.
 * Replaces any leftover Core names — they are not traded on this path.
 */
export async function writePremarketWatchlist(
  v2Symbols: WatchlistSymbol[],
  tradingDay: string,
): Promise<Watchlist> {
  const watchlist: Watchlist = {
    generatedAt: new Date().toISOString(),
    tradingDay,
    benchmarkReturn: null,
    universeSize: v2Symbols.length,
    liquidFiltered: v2Symbols.length,
    symbols: v2Symbols,
  };
  await writeWatchlist(watchlist);
  return watchlist;
}
