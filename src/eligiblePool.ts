/**
 * 09:15 eligible pool — actions in the price band with yesterday's dollar volume.
 *
 * When the opening-extension scanner is on, this list is NOT the entry universe.
 * It is the snapshot universe the 09:31 scanner ranks by (last − open) / open.
 */

import path from 'path';
import alpaca from './alpacaClient';
import config from './config';
import { createLogger } from './logger';
import { queryRequiredWatchlistTradingDay } from './marketCalendar';
import { readJson, writeJsonAtomic } from './jsonStore';
import { getDynamicUniverse } from './screener';
import { passesDollarVolume, passesPremarketPricePair } from './screenerMath';
import {
  extractLastPrint,
  extractPreviousClose,
  extractPreviousVolume,
  resolveSnapshotTicker,
} from './snapshotFields';
import { toErrorMessage } from './utils';
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

async function scanPool(universe: string[]): Promise<EligiblePoolEntry[]> {
  const hits: EligiblePoolEntry[] = [];
  let rejectedPrice = 0;
  let rejectedLiquidity = 0;
  let rejectedMissing = 0;

  for (let i = 0; i < universe.length; i += SNAPSHOT_BATCH_SIZE) {
    const batch = universe.slice(i, i + SNAPSHOT_BATCH_SIZE);
    try {
      const snapshots = await alpaca.getSnapshots(batch);
      for (const snap of snapshots) {
        const ticker = resolveSnapshotTicker(snap);
        if (ticker === null) continue;
        const lastPrice = extractLastPrint(snap);
        const previousClose = extractPreviousClose(snap);
        if (lastPrice === null || previousClose === null) {
          rejectedMissing++;
          continue;
        }
        if (!passesPremarketPricePair(
          lastPrice,
          previousClose,
          config.screener.minClosePrice,
          config.screener.maxClosePrice,
        )) {
          rejectedPrice++;
          continue;
        }
        const prevVolume = extractPreviousVolume(snap);
        if (!passesDollarVolume(
          previousClose,
          prevVolume,
          config.premarket.poolMinPrevDollarVolume,
        )) {
          rejectedLiquidity++;
          continue;
        }
        hits.push({
          symbol: ticker,
          previousClose,
          lastPrice,
          prevDollarVolume: previousClose * prevVolume,
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

  hits.sort((a, b) => b.prevDollarVolume - a.prevDollarVolume);
  log.info(
    `Pool scan: ${hits.length} eligible | rejects price=${rejectedPrice} ` +
    `liquidity=${rejectedLiquidity} missing=${rejectedMissing}`,
  );
  return hits;
}

export function toWarmupWatchlist(
  pool: EligiblePool,
  maxSymbols: number,
): WatchlistSymbol[] {
  return pool.symbols.slice(0, maxSymbols).map(entry => ({
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
    log.info('Building eligible pool from Alpaca snapshots...');
    const universe = await getDynamicUniverse();
    if (universe.length === 0) {
      throw new Error('[ELIGIBLE_POOL] Empty tradable universe');
    }
    const symbols = (await scanPool(universe)).slice(0, config.premarket.poolMaxSize);
    pool = {
      generatedAt: new Date().toISOString(),
      tradingDay,
      universeSize: universe.length,
      symbols,
    };
    await writeEligiblePool(pool);
    log.info(
      `Eligible pool written — ${pool.symbols.length} names ` +
      `(cap ${config.premarket.poolMaxSize}, prev $ vol ≥ ` +
      `$${Math.round(config.premarket.poolMinPrevDollarVolume).toLocaleString()})`,
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
