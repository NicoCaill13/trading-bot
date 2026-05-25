import fs from 'fs/promises';
import path from 'path';
import config from './config';
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

export async function readWatchlist(): Promise<Watchlist | null> {
  const watchlistPath = path.resolve(config.paths.watchlist);
  try {
    const raw = await fs.readFile(watchlistPath, 'utf8');
    return JSON.parse(raw) as Watchlist;
  } catch {
    return null;
  }
}

export async function writeWatchlist(watchlist: Watchlist): Promise<void> {
  const outputPath = path.resolve(config.paths.watchlist);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(watchlist, null, 2));
}

/**
 * Merges V2 Play-Maker symbols into the daily watchlist without dropping V1 Core entries.
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
    generatedAt: new Date().toISOString(),
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
