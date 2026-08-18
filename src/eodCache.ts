import fs from 'fs/promises';
import path from 'path';
import config from './config';
import { createLogger } from './logger';
import { writeJsonAtomic } from './jsonStore';
import { toErrorMessage } from './utils';
import type { SplitAdjustmentMode } from './corporateActions';
import type { AlpacaBar } from '@alpacahq/alpaca-trade-api';

const log = createLogger('EOD_CACHE');

/**
 * Immutable per-session store of adjusted daily bars.
 *
 * The screener can run several times in one evening (manual re-run, cron retry,
 * post-fix verification). Without this cache each run re-derives its history
 * from a live API and the SMA200 — hence Weinstein Phase 2, hence the whole
 * watchlist — can differ between two runs minutes apart. Persisting the series
 * makes the first run of a trading day authoritative.
 *
 * Directories are keyed by NY trading day, never by UTC date, so an evening run
 * either side of UTC midnight lands in the same bucket.
 */
export interface EodCacheRecord {
  symbol: string;
  /** NY trading day the run belongs to (YYYY-MM-DD). */
  tradingDay: string;
  /** Inclusive window start the series was fetched with (YYYY-MM-DD). */
  startDay: string;
  adjustment: SplitAdjustmentMode;
  bars: AlpacaBar[];
}

/**
 * Symbols become path segments, so only the shapes Alpaca actually issues are
 * accepted (AAPL, BRK.B). Anything else — including any form of traversal — is
 * refused rather than sanitised, so a malformed universe entry cannot write
 * outside the cache root.
 */
const SAFE_SYMBOL = /^[A-Z][A-Z0-9]*(?:\.[A-Z0-9]+)*$/;

function resolveRecordPath(tradingDay: string, symbol: string): string | null {
  if (!SAFE_SYMBOL.test(symbol)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradingDay)) return null;
  return path.resolve(config.paths.eodCache, tradingDay, `${symbol}.json`);
}

function isAlpacaBar(value: unknown): value is AlpacaBar {
  if (typeof value !== 'object' || value === null) return false;
  const bar = value as Record<string, unknown>;
  return (
    typeof bar.Timestamp === 'string' &&
    typeof bar.OpenPrice === 'number' &&
    typeof bar.HighPrice === 'number' &&
    typeof bar.LowPrice === 'number' &&
    typeof bar.ClosePrice === 'number' &&
    typeof bar.Volume === 'number'
  );
}

function isEodCacheRecord(value: unknown): value is EodCacheRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.symbol === 'string' &&
    typeof record.tradingDay === 'string' &&
    typeof record.startDay === 'string' &&
    (record.adjustment === 'own' || record.adjustment === 'alpaca') &&
    Array.isArray(record.bars) &&
    record.bars.every(isAlpacaBar)
  );
}

/**
 * Returns the cached series only when it was built for the same window and the
 * same adjustment mode. A shorter window or a mode change (own vs broker) is a
 * miss, not a partial hit — mixing the two would reintroduce the drift the
 * cache exists to remove.
 */
export async function readEodBars(
  tradingDay: string,
  symbol: string,
  startDay: string,
  adjustment: SplitAdjustmentMode,
): Promise<AlpacaBar[] | null> {
  const recordPath = resolveRecordPath(tradingDay, symbol);
  if (recordPath === null) return null;

  let raw: string;
  try {
    raw = await fs.readFile(recordPath, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn(`${symbol}: corrupt cache entry ignored (${recordPath})`);
    return null;
  }

  if (!isEodCacheRecord(parsed)) {
    log.warn(`${symbol}: cache entry failed validation, ignored (${recordPath})`);
    return null;
  }
  if (parsed.startDay !== startDay || parsed.adjustment !== adjustment) return null;

  return parsed.bars;
}

/**
 * Persisted atomically: a crash mid-write must not leave a truncated JSON that
 * the next run would read as a valid — but incomplete — history.
 */
export async function writeEodBars(
  tradingDay: string,
  symbol: string,
  startDay: string,
  adjustment: SplitAdjustmentMode,
  bars: readonly AlpacaBar[],
): Promise<void> {
  const recordPath = resolveRecordPath(tradingDay, symbol);
  if (recordPath === null) {
    log.warn(`${symbol}: unsupported symbol or trading day, not cached`);
    return;
  }

  const record: EodCacheRecord = {
    symbol,
    tradingDay,
    startDay,
    adjustment,
    bars: [...bars],
  };

  try {
    await writeJsonAtomic(recordPath, record);
  } catch (err) {
    log.warn(`${symbol}: cache write failed — ${toErrorMessage(err)}`);
  }
}
