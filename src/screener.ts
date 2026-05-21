import fs from 'fs/promises';
import path from 'path';
import alpaca from './alpacaClient';
import config from './config';
import { createLogger } from './logger';
import { toErrorMessage } from './utils';
import type { Watchlist, WatchlistSymbol } from './types';
import type { AlpacaBar } from '@alpacahq/alpaca-trade-api';

const log = createLogger('SCREENER');

const BENCHMARK = 'SPY';
const SNAPSHOT_BATCH_SIZE = 100;
const ANALYSIS_CONCURRENCY = 5;

// ---------------------------------------------------------------------------
// 1. Dynamic universe
// ---------------------------------------------------------------------------

async function getDynamicUniverse(): Promise<string[]> {
  log.info('Fetching dynamic universe from Alpaca...');

  const assets = await alpaca.getAssets({
    status: 'active',
    asset_class: 'us_equity',
  });

  const filtered = assets.filter(
    a => a.tradable &&
      a.marginable &&
      !a.symbol.includes('.') &&
      !a.symbol.includes('/'),
  );

  log.info(
    `Raw universe: ${assets.length} assets | ` +
    `${filtered.length} after filtering (tradable + marginable + clean symbol)`,
  );

  return filtered.map(a => a.symbol);
}

// ---------------------------------------------------------------------------
// 2. Liquidity pre-filter via snapshots (one request per batch of 100)
// ---------------------------------------------------------------------------

async function preFilterByLiquidity(symbols: string[]): Promise<string[]> {
  log.info(
    `Liquidity pre-filter on ${symbols.length} symbols ` +
    `(close ≥ $${config.screener.minClosePrice}, ` +
    `DV ≥ $${(config.screener.minDollarVolume / 1_000_000).toFixed(0)}M)...`,
  );

  const qualified: string[] = [];

  for (let i = 0; i < symbols.length; i += SNAPSHOT_BATCH_SIZE) {
    const batch = symbols.slice(i, i + SNAPSHOT_BATCH_SIZE);

    try {
      // No second arg — SDK uses this.configuration (with credentials) by default.
      // Return type is AlpacaSnapshot[] (array); Symbol field identifies the ticker.
      const snapshots = await alpaca.getSnapshots(batch);

      for (const snap of snapshots) {
        // DailyBar preferred; fall back to PrevDailyBar when market is closed
        const bar = snap.DailyBar ?? snap.PrevDailyBar;
        if (!bar) continue;

        const close = bar.ClosePrice;
        const volume = bar.Volume;

        if (close < config.screener.minClosePrice) continue;
        if (close * volume < config.screener.minDollarVolume) continue;

        // SDK may expose ticker as Symbol (typed) or symbol (JSON camelCase)
        const ticker =
          snap.Symbol ??
          (snap as { symbol?: string }).symbol ??
          bar.Symbol ??
          (bar as { symbol?: string }).symbol;
        if (!ticker) {
          log.warn('Snapshot skipped — missing ticker on snapshot/bar payload');
          continue;
        }
        qualified.push(ticker);
      }
    } catch (err) {
      log.warn(
        `Snapshot batch [${i}–${Math.min(i + SNAPSHOT_BATCH_SIZE, symbols.length) - 1}] ` +
        `skipped: ${toErrorMessage(err)}`,
      );
    }

    if (i + SNAPSHOT_BATCH_SIZE < symbols.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  log.info(`Pre-filter done: ${qualified.length}/${symbols.length} symbols retained`);

  return qualified;
}

// ---------------------------------------------------------------------------
// 3. Historical analysis
// ---------------------------------------------------------------------------

async function fetchDailyBars(symbol: string, limit: number): Promise<AlpacaBar[]> {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - Math.ceil(limit * 1.6) + 1);

  const bars: AlpacaBar[] = [];
  const iter = alpaca.getBarsV2(symbol, {
    start: start.toISOString().split('T')[0],
    end: end.toISOString().split('T')[0],
    timeframe: '1Day',
    feed: 'iex',
  });

  for await (const bar of iter) {
    bars.push(bar);
  }

  return bars.slice(-limit);
}

function computeReturn(bars: AlpacaBar[]): number | null {
  if (bars.length < 2) return null;
  const first = bars[0].ClosePrice;
  const last = bars[bars.length - 1].ClosePrice;
  return (last - first) / first;
}

function computeRelativeVolume(bars: AlpacaBar[], averageDays: number): number | null {
  if (bars.length < averageDays + 1) return null;
  const recent = bars[bars.length - 1];
  const historicalSlice = bars.slice(-(averageDays + 1), -1);
  const avgVolume = historicalSlice.reduce((sum, b) => sum + b.Volume, 0) / historicalSlice.length;
  if (avgVolume === 0) return null;
  return recent.Volume / avgVolume;
}

// Gap Up = (Open_j − Close_j-1) / Close_j-1
function computeGapUp(bars: AlpacaBar[]): number | null {
  if (bars.length < 2) return null;
  const prevClose = bars[bars.length - 2].ClosePrice;
  const todayOpen = bars[bars.length - 1].OpenPrice;
  return (todayOpen - prevClose) / prevClose;
}

// Gap held: Close_j > Open_j × (1 − tolerance) — excludes fully-filled intraday gaps
function isGapHeld(bars: AlpacaBar[]): boolean {
  const today = bars[bars.length - 1];
  return today.ClosePrice > today.OpenPrice * (1 - config.screener.gapHoldTolerance);
}

async function analyzeSymbol(
  symbol: string,
  benchmarkReturn: number,
  lookbackDays: number,
): Promise<WatchlistSymbol | null> {
  const ticker =
    typeof symbol === 'string' && symbol.trim().length > 0 ? symbol.trim() : null;

  if (!ticker) {
    log.warn('REJECTED — missing ticker (undefined snapshot Symbol — check preFilterByLiquidity)');
    return null;
  }

  try {
    const needed = lookbackDays + config.screener.volumeAverageDays + 2;
    const bars = await fetchDailyBars(ticker, needed);

    if (bars.length < needed) {
      log.info(
        `${ticker} REJECTED — insufficient history ` +
        `(${bars.length}/${needed} bars available)`,
      );
      return null;
    }

    const lastBar = bars[bars.length - 1];
    const lastClose = lastBar.ClosePrice;
    const lastVolume = lastBar.Volume;

    // Double liquidity check on actual historical data
    if (lastClose < config.screener.minClosePrice) {
      log.info(
        `${ticker} REJECTED — price $${lastClose.toFixed(2)} ` +
        `below $${config.screener.minClosePrice} floor`,
      );
      return null;
    }

    const dv = lastClose * lastVolume;
    if (dv < config.screener.minDollarVolume) {
      log.info(
        `${symbol.padEnd(6)} REJECTED — dollar volume $${(dv / 1_000_000).toFixed(1)}M ` +
        `below $${(config.screener.minDollarVolume / 1_000_000).toFixed(0)}M threshold`,
      );
      return null;
    }

    const symbolReturn = computeReturn(bars.slice(-lookbackDays));
    const relativeVolume = computeRelativeVolume(bars, config.screener.volumeAverageDays);
    const gapUp = computeGapUp(bars);

    if (symbolReturn === null || relativeVolume === null || gapUp === null) {
      log.info(
        `${ticker} REJECTED — incomplete indicators ` +
        `(return:${symbolReturn === null ? 'N/A' : 'ok'} ` +
        `rvol:${relativeVolume === null ? 'N/A' : 'ok'} ` +
        `gap:${gapUp === null ? 'N/A' : 'ok'})`,
      );
      return null;
    }

    if (symbolReturn <= benchmarkReturn) {
      log.info(
        `${ticker} REJECTED — relative strength: ` +
        `symbol ${(symbolReturn * 100).toFixed(2)}% vs SPY ${(benchmarkReturn * 100).toFixed(2)}% ` +
        `(alpha ${((symbolReturn - benchmarkReturn) * 100).toFixed(2)}%)`,
      );
      return null;
    }

    if (gapUp < config.screener.minGapUpPct) {
      log.info(
        `${ticker} REJECTED — gap up ${(gapUp * 100).toFixed(2)}% ` +
        `below ${(config.screener.minGapUpPct * 100).toFixed(1)}% minimum`,
      );
      return null;
    }

    if (!isGapHeld(bars)) {
      const today = bars[bars.length - 1];
      const floorPrice = today.OpenPrice * (1 - config.screener.gapHoldTolerance);
      log.info(
        `${ticker} REJECTED — gap not held: ` +
        `close $${today.ClosePrice.toFixed(2)} fell below open floor $${floorPrice.toFixed(2)} ` +
        `(open $${today.OpenPrice.toFixed(2)}, tolerance ${(config.screener.gapHoldTolerance * 100).toFixed(1)}%)`,
      );
      return null;
    }

    if (relativeVolume < config.screener.minRelativeVolume) {
      log.info(
        `${ticker} REJECTED — RVOL ${relativeVolume.toFixed(2)}x ` +
        `below ${config.screener.minRelativeVolume}x minimum`,
      );
      return null;
    }

    return {
      symbol: ticker,
      relativeReturn: symbolReturn - benchmarkReturn,
      symbolReturn,
      gapUp,
      gapHeld: true,
      relativeVolume,
      dollarVolume: lastClose * lastVolume,
      lastClose,
      lastOpen: lastBar.OpenPrice,
    };
  } catch (err) {
    log.warn(`${ticker}: analysis error — ${toErrorMessage(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 4. Throttled concurrent map
// ---------------------------------------------------------------------------

async function throttledMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number = ANALYSIS_CONCURRENCY,
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

// ---------------------------------------------------------------------------
// 5. Benchmark
// ---------------------------------------------------------------------------

async function computeBenchmarkReturn(lookbackDays: number): Promise<number | null> {
  log.info(`Fetching benchmark data for ${BENCHMARK}...`);
  const needed = lookbackDays + config.screener.volumeAverageDays + 2;
  const bars = await fetchDailyBars(BENCHMARK, needed);
  return computeReturn(bars.slice(-lookbackDays));
}

// ---------------------------------------------------------------------------
// 6. Main entry point
// ---------------------------------------------------------------------------

export async function runScreener(): Promise<Watchlist> {
  log.info('Starting post-session screening...');
  const lookbackDays = config.screener.relativeStrengthLookbackDays;

  const rawUniverse = await getDynamicUniverse();

  const liquidUniverse = await preFilterByLiquidity(rawUniverse);

  if (liquidUniverse.length === 0) {
    log.warn('Empty universe after liquidity pre-filter — screening aborted');
    return {
      generatedAt: new Date().toISOString(),
      benchmarkReturn: null,
      universeSize: rawUniverse.length,
      liquidFiltered: 0,
      symbols: [],
    };
  }

  const benchmarkReturn = await computeBenchmarkReturn(lookbackDays);
  if (benchmarkReturn === null) {
    log.warn('Failed to compute benchmark return — screening aborted');
    return {
      generatedAt: new Date().toISOString(),
      benchmarkReturn: null,
      universeSize: rawUniverse.length,
      liquidFiltered: liquidUniverse.length,
      symbols: [],
    };
  }

  log.info(
    `${BENCHMARK} return over ${lookbackDays}d: ${(benchmarkReturn * 100).toFixed(2)}%`,
  );

  log.info(`Full analysis on ${liquidUniverse.length} qualified symbols...`);
  const candidates = await throttledMap(
    liquidUniverse,
    symbol => analyzeSymbol(symbol, benchmarkReturn, lookbackDays),
    ANALYSIS_CONCURRENCY,
  );

  const filtered = (candidates.filter(Boolean) as WatchlistSymbol[])
    .sort((a, b) => b.relativeReturn - a.relativeReturn)
    .slice(0, config.screener.watchlistMaxSize);

  log.info(
    `${filtered.length} symbols retained from ${liquidUniverse.length} analyzed ` +
    `(initial universe: ${rawUniverse.length})`,
  );

  filtered.forEach(s => {
    log.info(
      `  ${s.symbol.padEnd(6)} | alpha: ${(s.relativeReturn * 100).toFixed(2)}% ` +
      `| gap: ${(s.gapUp * 100).toFixed(2)}% | rvol: ${s.relativeVolume.toFixed(2)}x ` +
      `| DV: $${(s.dollarVolume / 1_000_000).toFixed(0)}M ` +
      `| close: $${s.lastClose.toFixed(2)}`,
    );
  });

  const watchlist: Watchlist = {
    generatedAt: new Date().toISOString(),
    benchmarkReturn,
    universeSize: rawUniverse.length,
    liquidFiltered: liquidUniverse.length,
    symbols: filtered,
  };

  const outputPath = path.resolve(config.paths.watchlist);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(watchlist, null, 2));
  log.info(`Watchlist saved: ${outputPath}`);

  return watchlist;
}

// Allow direct execution: tsx src/screener.ts
if (require.main === module) {
  runScreener().catch((err: unknown) => {
    console.error(toErrorMessage(err));
    process.exit(1);
  });
}
