import alpaca from './alpacaClient';
import config from './config';
import { getDynamicUniverse } from './screener';
import { createLogger } from './logger';
import { clampQueryEnd, getESTDate, nyWallTimeToUtc, toErrorMessage } from './utils';
import { mergeV2IntoWatchlist, readWatchlist, getSymbolOrigin, writePremarketWatchlist } from './watchlistIO';
import { queryRequiredWatchlistTradingDay } from './marketCalendar';
import { notifyWatchlistSaved } from './notificationManager';
import { passesPriceBand, sumShareVolume } from './screenerMath';
import { createNewsProvider } from './newsProvider';
import { filterWatchlistByBullishCatalyst } from './sentiment';
import type { Watchlist, WatchlistSymbol } from './types';
import type { AlpacaBar, AlpacaSnapshot } from '@alpacahq/alpaca-trade-api';

const log = createLogger('PREMARKET_SCREENER');
const newsProvider = createNewsProvider();

const SNAPSHOT_BATCH_SIZE = 100;
const VOLUME_FETCH_CONCURRENCY = 5;

interface GapCandidate {
  symbol: string;
  preMarketGapPct: number;
  preMarketPrice: number;
  previousClose: number;
  preMarketShareVolume: number;
}

interface SnapshotGapHit {
  symbol: string;
  preMarketGapPct: number;
  preMarketPrice: number;
  previousClose: number;
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

/** EST pre-market share volume window: [04:00, 09:30). */
async function fetchPremarketShareVolume(symbol: string): Promise<number> {
  const estDay = getESTDate();
  const start = nyWallTimeToUtc(estDay, 4, 0);
  // Runs at ~09:15, so a delayed SIP plan would 403 on a 09:30 end boundary.
  const end = clampQueryEnd(
    nyWallTimeToUtc(estDay, 9, 30),
    config.alpaca.dataFeed,
    config.alpaca.sipDelayMs,
  );

  const bars: AlpacaBar[] = [];
  const iter = alpaca.getBarsV2(symbol, {
    start: start.toISOString(),
    end: end.toISOString(),
    timeframe: '1Min',
    feed: config.alpaca.dataFeed,
  });

  for await (const bar of iter) {
    // Exclude the 09:30 bar if the API returns an inclusive end boundary.
    const ts = new Date(bar.Timestamp).getTime();
    if (ts >= end.getTime()) continue;
    if (ts < start.getTime()) continue;
    bars.push(bar);
  }

  return sumShareVolume(bars.map(b => ({ volume: b.Volume })));
}

async function throttledMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    if (i + concurrency < items.length) {
      await new Promise(r => setTimeout(r, 350));
    }
  }
  return results;
}

/**
 * Phase 1: snapshot scan for price + gap only (cheap).
 * Phase 2: 1Min bar volume sum in EST [04:00, 09:30) for gap hits only.
 */
async function scanGapCandidates(universe: string[]): Promise<GapCandidate[]> {
  const gapHits: SnapshotGapHit[] = [];
  const minGap = config.premarket.minGapUpPct;
  const minClose = config.screener.minClosePrice;
  const maxClose = config.screener.maxClosePrice;
  const minShares = config.premarket.minPreMarketShareVolume;

  let rejectedMissingPrice = 0;
  let rejectedPrice = 0;
  let rejectedGap = 0;

  log.info(
    `Snapshot scan on ${universe.length} tradable symbols ` +
    `(price $${minClose}–$${maxClose}, gap ≥ ${(minGap * 100).toFixed(1)}%, ` +
    `then pre-market vol ≥ ${(minShares / 1_000_000).toFixed(1)}M shares before 09:30 EST)...`,
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
        if (previousClose === null || preMarketPrice === null) {
          rejectedMissingPrice++;
          continue;
        }

        if (!passesPriceBand(preMarketPrice, minClose, maxClose)) {
          rejectedPrice++;
          continue;
        }

        const gap = (preMarketPrice - previousClose) / previousClose;
        if (gap < minGap) {
          rejectedGap++;
          continue;
        }

        gapHits.push({
          symbol: ticker,
          preMarketGapPct: gap,
          preMarketPrice,
          previousClose,
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

  log.info(
    `Snapshot phase: ${gapHits.length} gap hits | ` +
    `rejects price=${rejectedPrice} gap=${rejectedGap} missing_price=${rejectedMissingPrice}`,
  );

  const volumeResults = await throttledMap(
    gapHits,
    async (hit): Promise<GapCandidate | null> => {
      try {
        const preMarketShareVolume = await fetchPremarketShareVolume(hit.symbol);
        if (preMarketShareVolume < minShares) {
          log.info(
            `${hit.symbol} REJECTED — premarket volume ${preMarketShareVolume} ` +
            `below ${minShares} (EST 04:00–09:30)`,
          );
          return null;
        }
        return { ...hit, preMarketShareVolume };
      } catch (err) {
        log.warn(
          `${hit.symbol} REJECTED — premarket volume fetch failed: ${toErrorMessage(err)}`,
        );
        return null;
      }
    },
    VOLUME_FETCH_CONCURRENCY,
  );

  return volumeResults.filter((c): c is GapCandidate => c !== null);
}

function toWatchlistEntries(candidates: GapCandidate[]): WatchlistSymbol[] {
  return candidates
    .sort((a, b) => b.preMarketGapPct - a.preMarketGapPct)
    .map(c => ({
      symbol: c.symbol,
      origin: 'V2_PLAYMAKER' as const,
      source: 'satellite' as const,
      preMarketGapPct: c.preMarketGapPct,
      gapUp: c.preMarketGapPct,
      lastClose: c.preMarketPrice,
      previousClose: c.previousClose,
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

  const ranked = toWatchlistEntries(dedupedCandidates);
  const poolSize = config.sentiment.enabled
    ? Math.min(ranked.length, Math.max(config.premarket.watchlistMaxSize * 3, 30))
    : config.premarket.watchlistMaxSize;
  const v2SymbolsRaw = ranked.slice(0, poolSize);
  const withCatalyst = await filterWatchlistByBullishCatalyst(v2SymbolsRaw, newsProvider);
  const v2Symbols = withCatalyst.slice(0, config.premarket.watchlistMaxSize);

  v2Symbols.forEach(s => {
    log.info(
      `  ${s.symbol.padEnd(6)} | gap ${((s.preMarketGapPct ?? 0) * 100).toFixed(2)}% ` +
      `| close $${(s.lastClose ?? 0).toFixed(2)}` +
      (s.sentiment ? ` | sent: ${s.sentiment}` : ''),
    );
  });

  const tradingDay = await queryRequiredWatchlistTradingDay();
  if (!config.screener.eveningScreenerEnabled && tradingDay === null) {
    throw new Error('[PREMARKET_SCREENER] Cannot resolve required EOD trading day');
  }
  const watchlist = config.screener.eveningScreenerEnabled
    ? await mergeV2IntoWatchlist(v2Symbols)
    : await writePremarketWatchlist(v2Symbols, tradingDay as string);

  log.info(
    `${v2Symbols.length} V2_PLAYMAKER symbol(s) merged into watchlist.json ` +
    `(${watchlist.symbols.length} total` +
    (config.sentiment.enabled
      ? `; catalyst ${withCatalyst.length}/${v2SymbolsRaw.length}`
      : '') +
    `)`,
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
