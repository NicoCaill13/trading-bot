/**
 * 09:15 eligible pool — actions in the price band with yesterday's dollar volume.
 *
 * When the opening-extension scanner is on, this list is NOT the entry universe.
 * It is the snapshot universe the 09:31 scanner ranks by (last − open) / open.
 *
 * Previous close and volume come from SIP daily bars. Alpaca getSnapshots does
 * not pass a feed query param (SDK 3.1.x), so PrevDailyBar is IEX-scale and
 * silently drops quiet-yesterday runners (CHPT 03/09: $265k IEX vs $8.5M SIP).
 * Snapshots are kept only for the pre-market last print.
 */

import path from 'path';
import alpaca from './alpacaClient';
import config from './config';
import { createLogger } from './logger';
import {
  getPreviousTradingDay,
  queryRequiredWatchlistTradingDay,
} from './marketCalendar';
import { readJson, writeJsonAtomic } from './jsonStore';
import { getDynamicUniverse } from './screener';
import { dailyLiquidityBySymbol, fetchDailyBars, type DailyLiquidity } from './dailyBars';
import { passesDollarVolumeBand, passesPremarketPricePair } from './screenerMath';
import {
  extractLastPrint,
  resolveSnapshotTicker,
} from './snapshotFields';
import { nyWallTimeToUtc, toErrorMessage } from './utils';
import { writePremarketWatchlist } from './watchlistIO';
import type { Watchlist, WatchlistSymbol } from './types';

const log = createLogger('ELIGIBLE_POOL');
const SNAPSHOT_BATCH_SIZE = 100;

export interface EligiblePoolEntry {
  symbol: string;
  previousClose: number;
  lastPrice: number;
  prevDollarVolume: number;
}

export interface EligiblePool {
  generatedAt: string;
  tradingDay: string;
  universeSize: number;
  symbols: EligiblePoolEntry[];
}

export interface PoolPrint {
  symbol: string;
  lastPrice: number;
}

export interface EligiblePoolSelectOpts {
  minPrice: number;
  maxPrice: number;
  minPrevDollarVolume: number;
  maxPrevDollarVolume: number;
  maxSize: number;
}

function isEligiblePool(value: unknown): value is EligiblePool {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['generatedAt'] === 'string' &&
    typeof record['tradingDay'] === 'string' &&
    Array.isArray(record['symbols'])
  );
}

export async function readEligiblePool(): Promise<EligiblePool | null> {
  const parsed = await readJson(path.resolve(config.paths.eligiblePool));
  return isEligiblePool(parsed) ? parsed : null;
}

export async function writeEligiblePool(pool: EligiblePool): Promise<void> {
  await writeJsonAtomic(path.resolve(config.paths.eligiblePool), pool, { pretty: true });
}

/**
 * Join pre-market last prints with SIP previous-session liquidity.
 *
 * Overflow past `maxSize` drops the *most* liquid names first so mega caps
 * cannot crowd out the small names that actually move 10%.
 */
export function selectEligiblePoolEntries(
  prints: readonly PoolPrint[],
  daily: ReadonlyMap<string, DailyLiquidity>,
  opts: EligiblePoolSelectOpts,
): {
  hits: EligiblePoolEntry[];
  rejectedPrice: number;
  rejectedLiquidity: number;
  rejectedMissing: number;
} {
  const hits: EligiblePoolEntry[] = [];
  let rejectedPrice = 0;
  let rejectedLiquidity = 0;
  let rejectedMissing = 0;

  for (const print of prints) {
    const liq = daily.get(print.symbol);
    if (liq === undefined) {
      rejectedMissing++;
      continue;
    }
    if (!passesPremarketPricePair(
      print.lastPrice,
      liq.previousClose,
      opts.minPrice,
      opts.maxPrice,
    )) {
      rejectedPrice++;
      continue;
    }
    const prevDollarVolume = liq.previousClose * liq.previousVolume;
    if (!passesDollarVolumeBand(
      prevDollarVolume,
      opts.minPrevDollarVolume,
      opts.maxPrevDollarVolume,
    )) {
      rejectedLiquidity++;
      continue;
    }
    hits.push({
      symbol: print.symbol,
      previousClose: liq.previousClose,
      lastPrice: print.lastPrice,
      prevDollarVolume,
    });
  }

  hits.sort((a, b) => a.prevDollarVolume - b.prevDollarVolume);
  const capped = hits.length > opts.maxSize ? hits.slice(0, opts.maxSize) : hits;
  return {
    hits: capped,
    rejectedPrice,
    rejectedLiquidity,
    rejectedMissing: rejectedMissing + (hits.length - capped.length),
  };
}

async function collectPremarketPrints(universe: string[]): Promise<PoolPrint[]> {
  const prints: PoolPrint[] = [];

  for (let i = 0; i < universe.length; i += SNAPSHOT_BATCH_SIZE) {
    const batch = universe.slice(i, i + SNAPSHOT_BATCH_SIZE);
    try {
      const snapshots = await alpaca.getSnapshots(batch);
      for (const snap of snapshots) {
        const ticker = resolveSnapshotTicker(snap);
        if (ticker === null) continue;
        const lastPrice = extractLastPrint(snap);
        if (lastPrice === null) continue;
        prints.push({ symbol: ticker, lastPrice });
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

  return prints;
}

function sessionUtcDay(tradingDay: string): { start: Date; cutoff: Date } {
  const [year, month, day] = tradingDay.split('-').map(Number);
  const estDay = new Date(year, month - 1, day);
  return {
    start: nyWallTimeToUtc(new Date(year, month - 1, day - 10), 0, 0),
    cutoff: nyWallTimeToUtc(estDay, 0, 0),
  };
}

async function scanPool(universe: string[], tradingDay: string): Promise<EligiblePoolEntry[]> {
  const previousDay = await getPreviousTradingDay();
  if (previousDay === null) {
    throw new Error('[ELIGIBLE_POOL] Cannot resolve previous trading day');
  }

  const { start, cutoff } = sessionUtcDay(tradingDay);
  log.info(
    `Fetching SIP daily bars for ${universe.length} names ` +
    `(prev session ${previousDay})...`,
  );
  const dailyBars = await fetchDailyBars(universe, start, cutoff, config.alpaca.dataFeed);
  const daily = dailyLiquidityBySymbol(dailyBars, cutoff.getTime());
  log.info(`SIP daily liquidity for ${daily.size} name(s)`);

  const prints = await collectPremarketPrints(universe);
  const selected = selectEligiblePoolEntries(prints, daily, {
    minPrice: config.screener.minClosePrice,
    maxPrice: config.screener.maxClosePrice,
    minPrevDollarVolume: config.premarket.poolMinPrevDollarVolume,
    maxPrevDollarVolume: config.premarket.poolMaxPrevDollarVolume,
    maxSize: config.premarket.poolMaxSize,
  });

  log.info(
    `Pool scan: ${selected.hits.length} eligible | rejects price=${selected.rejectedPrice} ` +
    `liquidity=${selected.rejectedLiquidity} missing=${selected.rejectedMissing}`,
  );
  return selected.hits;
}

export function toWarmupWatchlist(
  pool: EligiblePool,
  maxSymbols: number,
): WatchlistSymbol[] {
  const ranked = [...pool.symbols].sort((a, b) => b.prevDollarVolume - a.prevDollarVolume);
  return ranked.slice(0, maxSymbols).map(entry => ({
    symbol: entry.symbol,
    origin: 'V2_PLAYMAKER' as const,
    source: 'satellite' as const,
    lastClose: entry.lastPrice,
    previousClose: entry.previousClose,
    dollarVolume: entry.prevDollarVolume,
  }));
}

/**
 * Builds (or reuses today's) eligible pool and writes a liquidity warmup
 * watchlist so the stream is hot at 09:30. Entry names still come from the
 * 09:31 scanner.
 */
export async function buildEligiblePool(): Promise<{ pool: EligiblePool; warmup: Watchlist }> {
  const tradingDay = await queryRequiredWatchlistTradingDay();
  if (tradingDay === null) {
    throw new Error('[ELIGIBLE_POOL] Cannot resolve required trading day');
  }

  const existing = await readEligiblePool();
  let pool = existing;
  if (pool === null || pool.tradingDay !== tradingDay || pool.symbols.length === 0) {
    log.info('Building eligible pool from SIP daily bars + Alpaca snapshots...');
    const universe = await getDynamicUniverse();
    if (universe.length === 0) {
      throw new Error('[ELIGIBLE_POOL] Empty tradable universe');
    }
    const symbols = await scanPool(universe, tradingDay);
    pool = {
      generatedAt: new Date().toISOString(),
      tradingDay,
      universeSize: universe.length,
      symbols,
    };
    await writeEligiblePool(pool);
    const maxDv = config.premarket.poolMaxPrevDollarVolume;
    log.info(
      `Eligible pool written — ${pool.symbols.length} names ` +
      `(cap ${config.premarket.poolMaxSize}, prev $ vol ≥ ` +
      `$${Math.round(config.premarket.poolMinPrevDollarVolume).toLocaleString()}` +
      (maxDv > 0 ? ` ≤ $${Math.round(maxDv).toLocaleString()}` : '') +
      `)`,
    );
  } else {
    log.info(
      `Eligible pool cache hit — ${pool.symbols.length} names for ${pool.tradingDay}`,
    );
  }

  const warmupSymbols = toWarmupWatchlist(pool, config.openingDrive.scannerMaxSymbols);
  const warmup = await writePremarketWatchlist(warmupSymbols, tradingDay);
  log.info(
    `Warmup watchlist — ${warmupSymbols.length} most-liquid pool names (bars only at the open)`,
  );
  return { pool, warmup };
}
