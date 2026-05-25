import alpaca from './alpacaClient';
import config from './config';
import { getDynamicUniverse } from './screener';
import { registerSatelliteWatchlist } from './signalQueue';
import { createLogger } from './logger';
import { toErrorMessage } from './utils';
import { mergeV2IntoWatchlist, readWatchlist, getSymbolOrigin } from './watchlistIO';
import { notifyWatchlistSaved } from './notificationManager';
import type { Watchlist, WatchlistSymbol } from './types';
import type { AlpacaSnapshot } from '@alpacahq/alpaca-trade-api';

const log = createLogger('PREMARKET_SCREENER');

const SNAPSHOT_BATCH_SIZE = 100;

interface GapCandidate {
  symbol: string;
  preMarketGapPct: number;
  preMarketPrice: number;
  previousClose: number;
  preMarketShareVolume: number;
}

function resolveSnapshotTicker(snap: AlpacaSnapshot): string | null {
  return (
    snap.Symbol ??
    (snap as { symbol?: string }).symbol ??
    snap.MinuteBar?.Symbol ??
    snap.PrevDailyBar?.Symbol ??
    null
  );
}

function extractPreMarketPrice(snap: AlpacaSnapshot): number | null {
  const minuteClose = snap.MinuteBar?.ClosePrice;
  if (minuteClose !== undefined && minuteClose > 0) return minuteClose;

  const latestTrade = snap.LatestTrade?.Price;
  if (latestTrade !== undefined && latestTrade > 0) return latestTrade;

  return null;
}

function extractPreviousClose(snap: AlpacaSnapshot): number | null {
  const prev = snap.PrevDailyBar?.ClosePrice;
  if (prev !== undefined && prev > 0) return prev;
  return null;
}

/** Cumulative share volume for the current session (includes pre-market). */
function extractPreMarketShareVolume(snap: AlpacaSnapshot): number {
  const dailyVolume = snap.DailyBar?.Volume;
  if (dailyVolume !== undefined && dailyVolume > 0) return dailyVolume;
  return 0;
}

async function scanGapCandidates(universe: string[]): Promise<GapCandidate[]> {
  const candidates: GapCandidate[] = [];
  const minGap = config.premarket.minGapUpPct;
  const minClose = config.screener.minClosePrice;
  const minShares = config.premarket.minPreMarketShareVolume;

  log.info(
    `Snapshot scan on ${universe.length} tradable symbols ` +
    `(close ≥ $${minClose}, gap ≥ ${(minGap * 100).toFixed(1)}%, ` +
    `pre-market vol ≥ ${(minShares / 1000).toFixed(0)}k shares)...`,
  );

  for (let i = 0; i < universe.length; i += SNAPSHOT_BATCH_SIZE) {
    const batch = universe.slice(i, i + SNAPSHOT_BATCH_SIZE);

    try {
      const snapshots = await alpaca.getSnapshots(batch);

      for (const snap of snapshots) {
        const ticker = resolveSnapshotTicker(snap);
        if (!ticker) continue;

        const previousClose = extractPreviousClose(snap);
        const preMarketPrice = extractPreMarketPrice(snap);
        if (previousClose === null || preMarketPrice === null) continue;

        if (previousClose < minClose) continue;

        const gap = (preMarketPrice - previousClose) / previousClose;
        if (gap < minGap) continue;

        const preMarketShareVolume = extractPreMarketShareVolume(snap);
        if (preMarketShareVolume < minShares) continue;

        candidates.push({
          symbol: ticker,
          preMarketGapPct: gap,
          preMarketPrice,
          previousClose,
          preMarketShareVolume,
        });
      }
    } catch (err) {
      log.warn(
        `Snapshot batch [${i}–${Math.min(i + SNAPSHOT_BATCH_SIZE, universe.length) - 1}] ` +
        `skipped: ${toErrorMessage(err)}`,
      );
    }

    if (i + SNAPSHOT_BATCH_SIZE < universe.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  return candidates;
}

function toWatchlistEntries(candidates: GapCandidate[]): WatchlistSymbol[] {
  return candidates
    .sort((a, b) => b.preMarketGapPct - a.preMarketGapPct)
    .slice(0, config.premarket.watchlistMaxSize)
    .map(c => ({
      symbol: c.symbol,
      origin: 'V2_PLAYMAKER' as const,
      source: 'satellite' as const,
      preMarketGapPct: c.preMarketGapPct,
      gapUp: c.preMarketGapPct,
      lastClose: c.preMarketPrice,
      dollarVolume: c.preMarketPrice * c.preMarketShareVolume,
    }));
}

/**
 * Play-Maker V2 — runs at 09:15 EST (cron in index.ts).
 * Scans the full tradable universe via Alpaca Snapshots and merges results into watchlist.json.
 */
export async function runPremarketScreener(): Promise<Watchlist> {
  log.info('Starting Play-Maker V2 pre-market screening...');

  const universe = await getDynamicUniverse();
  if (universe.length === 0) {
    log.warn('Empty tradable universe — pre-market screening aborted');
    return mergeV2IntoWatchlist([]);
  }

  const gapCandidates = await scanGapCandidates(universe);

  const existingWatchlist = await readWatchlist();
  const coreSymbols = new Set(
    (existingWatchlist?.symbols ?? [])
      .filter(s => getSymbolOrigin(s) === 'V1_CORE')
      .map(s => s.symbol),
  );

  const dedupedCandidates = gapCandidates.filter(c => {
    if (coreSymbols.has(c.symbol)) {
      log.info(`${c.symbol}: rejected — already in Core watchlist (V1_CORE priority)`);
      return false;
    }
    return true;
  });

  log.info(
    `${dedupedCandidates.length} V2 candidate(s) from ${universe.length} symbols ` +
    `(${gapCandidates.length - dedupedCandidates.length} deduped vs Core) ` +
    `(gap ≥ ${(config.premarket.minGapUpPct * 100).toFixed(1)}%)`,
  );

  const v2Symbols = toWatchlistEntries(dedupedCandidates);

  v2Symbols.forEach(s => {
    log.info(
      `  ${s.symbol.padEnd(6)} | gap ${((s.preMarketGapPct ?? 0) * 100).toFixed(2)}% ` +
      `| close $${(s.lastClose ?? 0).toFixed(2)}`,
    );
  });

  const watchlist = await mergeV2IntoWatchlist(v2Symbols);
  registerSatelliteWatchlist(v2Symbols.map(s => s.symbol));

  log.info(
    `${v2Symbols.length} V2_PLAYMAKER symbol(s) merged into watchlist.json ` +
    `(${watchlist.symbols.length} total)`,
  );

  void notifyWatchlistSaved(watchlist);

  return watchlist;
}

if (require.main === module) {
  runPremarketScreener().catch((err: unknown) => {
    console.error(toErrorMessage(err));
    process.exit(1);
  });
}
