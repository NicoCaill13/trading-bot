import path from 'path';
import alpaca from './alpacaClient';
import config, { getSma150SlopeLookbackBars } from './config';
import { createFloatProvider, isFloatFilterActive } from './floatProvider';
import { createLogger } from './logger';
import { toErrorMessage } from './utils';
import { readWatchlist, writeWatchlist, isV2Symbol } from './watchlistIO';
import { notifyWatchlistSaved } from './notificationManager';
import {
  computeAdrPct,
  isAllowedExchange,
  passesAdrGate,
  passesClosePrice,
  passesDollarVolume,
  passesFloatGate,
} from './screenerMath';
import {
  assessWeinsteinPhase2,
  passesWeinsteinGate,
} from './weinstein';
import { detectReversalPatterns } from './patterns/reversal';
import type { Watchlist, WatchlistSymbol, ReversalPatternSignal } from './types';
import type { AlpacaBar } from '@alpacahq/alpaca-trade-api';

const log = createLogger('SCREENER');
const weinsteinLog = createLogger('WEINSTEIN');
const patternLog = createLogger('PATTERN');
const floatProvider = createFloatProvider();

const BENCHMARK = 'SPY';
const SNAPSHOT_BATCH_SIZE = 100;
const ANALYSIS_CONCURRENCY = 5;

function dailyBarsNeeded(lookbackDays: number): number {
  const slopeBars = getSma150SlopeLookbackBars();
  return Math.max(
    lookbackDays + config.screener.volumeAverageDays + 2,
    config.screener.adrLookbackDays,
    config.screener.sma200Period + slopeBars,
  );
}

export interface UniverseAsset {
  symbol: string;
  exchange: string;
}

// ---------------------------------------------------------------------------
// 1. Dynamic universe
// ---------------------------------------------------------------------------

export async function getDynamicUniverseAssets(): Promise<UniverseAsset[]> {
  log.info('Fetching dynamic universe from Alpaca...');

  const assets = await alpaca.getAssets({
    status: 'active',
    asset_class: 'us_equity',
  });

  let rejectedExchange = 0;
  let rejectedDirty = 0;
  let rejectedNotTradable = 0;

  const filtered: UniverseAsset[] = [];

  for (const a of assets) {
    if (!a.tradable || !a.marginable) {
      rejectedNotTradable++;
      continue;
    }
    if (a.symbol.includes('.') || a.symbol.includes('/')) {
      rejectedDirty++;
      continue;
    }
    if (!isAllowedExchange(a.exchange ?? '', config.screener.allowedExchanges)) {
      rejectedExchange++;
      continue;
    }
    filtered.push({ symbol: a.symbol, exchange: a.exchange });
  }

  log.info(
    `Raw universe: ${assets.length} assets | ` +
    `${filtered.length} after filtering (tradable + marginable + clean + exchange) | ` +
    `rejects exchange=${rejectedExchange} dirty=${rejectedDirty} not_tradable=${rejectedNotTradable}`,
  );

  return filtered;
}

export async function getDynamicUniverse(): Promise<string[]> {
  const assets = await getDynamicUniverseAssets();
  return assets.map(a => a.symbol);
}

// ---------------------------------------------------------------------------
// 2. Liquidity pre-filter via snapshots (one request per batch of 100)
// ---------------------------------------------------------------------------

export async function preFilterByLiquidity(symbols: string[]): Promise<string[]> {
  log.info(
    `Liquidity pre-filter on ${symbols.length} symbols ` +
    `(close ≥ $${config.screener.minClosePrice}, ` +
    `DV ≥ $${(config.screener.minDollarVolume / 1_000_000).toFixed(0)}M)...`,
  );

  const qualified: string[] = [];
  let rejectedPrice = 0;
  let rejectedDv = 0;
  let rejectedNoBar = 0;
  let rejectedMissingTicker = 0;

  for (let i = 0; i < symbols.length; i += SNAPSHOT_BATCH_SIZE) {
    const batch = symbols.slice(i, i + SNAPSHOT_BATCH_SIZE);

    try {
      // No second arg — SDK uses this.configuration (with credentials) by default.
      // Return type is AlpacaSnapshot[] (array); Symbol field identifies the ticker.
      const snapshots = await alpaca.getSnapshots(batch);

      for (const snap of snapshots) {
        // DailyBar preferred; fall back to PrevDailyBar when market is closed
        const bar = snap.DailyBar ?? snap.PrevDailyBar;
        if (!bar) {
          rejectedNoBar++;
          continue;
        }

        const close = bar.ClosePrice;
        const volume = bar.Volume;

        if (!passesClosePrice(close, config.screener.minClosePrice)) {
          rejectedPrice++;
          continue;
        }
        if (!passesDollarVolume(close, volume, config.screener.minDollarVolume)) {
          rejectedDv++;
          continue;
        }

        // SDK may expose ticker as Symbol (typed) or symbol (JSON camelCase)
        const ticker =
          snap.Symbol ??
          (snap as { symbol?: string }).symbol ??
          bar.Symbol ??
          (bar as { symbol?: string }).symbol;
        if (!ticker) {
          rejectedMissingTicker++;
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

  log.info(
    `Pre-filter done: ${qualified.length}/${symbols.length} retained | ` +
    `rejects price=${rejectedPrice} dollar_volume=${rejectedDv} ` +
    `no_bar=${rejectedNoBar} missing_ticker=${rejectedMissingTicker}`,
  );

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
  exchange: string | undefined,
): Promise<WatchlistSymbol | null> {
  const ticker =
    typeof symbol === 'string' && symbol.trim().length > 0 ? symbol.trim() : null;

  if (!ticker) {
    log.warn('REJECTED — missing ticker (undefined snapshot Symbol — check preFilterByLiquidity)');
    return null;
  }

  try {
    const needed = dailyBarsNeeded(lookbackDays);
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
    if (!passesClosePrice(lastClose, config.screener.minClosePrice)) {
      log.info(
        `${ticker} REJECTED — price $${lastClose.toFixed(2)} ` +
        `below $${config.screener.minClosePrice} floor`,
      );
      return null;
    }

    const dv = lastClose * lastVolume;
    if (!passesDollarVolume(lastClose, lastVolume, config.screener.minDollarVolume)) {
      log.info(
        `${ticker} REJECTED — dollar volume $${(dv / 1_000_000).toFixed(1)}M ` +
        `below $${(config.screener.minDollarVolume / 1_000_000).toFixed(0)}M threshold`,
      );
      return null;
    }

    const adrPct = computeAdrPct(
      bars.map(b => ({ high: b.HighPrice, low: b.LowPrice, close: b.ClosePrice })),
      config.screener.adrLookbackDays,
    );
    if (adrPct === null) {
      log.info(
        `${ticker} REJECTED — ADR unavailable ` +
        `(need ${config.screener.adrLookbackDays} daily bars)`,
      );
      return null;
    }
    if (!passesAdrGate(adrPct, config.screener.minAdrPct)) {
      log.info(
        `${ticker} REJECTED — ADR ${adrPct.toFixed(2)}% ` +
        `<= ${config.screener.minAdrPct.toFixed(1)}% floor`,
      );
      return null;
    }

    let floatShares: number | undefined;
    if (isFloatFilterActive()) {
      const float = await floatProvider.getFloatShares(ticker);
      if (float === null) {
        log.info(`${ticker} REJECTED — float unavailable (provider returned null)`);
        return null;
      }
      if (!passesFloatGate(float, config.screener.minFloatShares, config.screener.maxFloatShares)) {
        log.info(
          `${ticker} REJECTED — float ${float} outside ` +
          `[${config.screener.minFloatShares}, ${config.screener.maxFloatShares}]`,
        );
        return null;
      }
      floatShares = float;
    }

    const closes = bars.map(b => b.ClosePrice);
    const weinstein = assessWeinsteinPhase2(closes, {
      sma150Period: config.screener.sma150Period,
      sma200Period: config.screener.sma200Period,
      slopeLookbackBars: getSma150SlopeLookbackBars(),
    });
    if (weinstein === null) {
      weinsteinLog.info(
        `${ticker} REJECTED — insufficient history for SMA150/200 + slope ` +
        `(need ${config.screener.sma200Period + getSma150SlopeLookbackBars()} closes)`,
      );
      return null;
    }
    if (!passesWeinsteinGate(weinstein)) {
      const reasons: string[] = [];
      if (!weinstein.priceAboveSmas) {
        reasons.push(
          `close $${weinstein.lastClose.toFixed(2)} <= SMA150 $${weinstein.sma150.toFixed(2)} ` +
          `or SMA200 $${weinstein.sma200.toFixed(2)}`,
        );
      }
      if (!weinstein.slopeNonNegative) {
        reasons.push(`SMA150 slope ${weinstein.sma150Slope.toFixed(4)} < 0`);
      }
      weinsteinLog.info(`${ticker} REJECTED — ${reasons.join('; ')}`);
      return null;
    }
    weinsteinLog.info(
      `${ticker} PASS — close $${weinstein.lastClose.toFixed(2)} ` +
      `> SMA150 $${weinstein.sma150.toFixed(2)} & SMA200 $${weinstein.sma200.toFixed(2)} ` +
      `| slope ${weinstein.sma150Slope.toFixed(4)}`,
    );

    let reversalPattern: WatchlistSymbol['reversalPattern'];
    let reversalDetail: ReversalPatternSignal | undefined;
    if (config.screener.patternFilterEnabled) {
      const lookback = Math.min(config.screener.patternLookbackBars, bars.length);
      const slice = bars.slice(-lookback);
      const ohlcv = slice.map(b => ({
        high: b.HighPrice,
        low: b.LowPrice,
        close: b.ClosePrice,
        volume: b.Volume,
      }));
      const signal = detectReversalPatterns(ohlcv, {
        pivotLeft: config.screener.patternPivotLeft,
        pivotRight: config.screener.patternPivotRight,
        eteiBreakoutRvol: config.screener.eteiBreakoutRvol,
        springReclaimRvol: config.screener.springReclaimRvol,
        springSupportTolerancePct: config.screener.springSupportTolerancePct,
        rvolAvgDays: config.screener.patternRvolAvgDays,
      });
      if (signal) {
        reversalPattern = signal.pattern;
        reversalDetail = signal;
        const pivots = signal.pivots.map(p => p.price.toFixed(2)).join('/');
        patternLog.info(
          `${ticker} PASS — ${signal.pattern} pivots ${pivots}` +
          (signal.neckline !== undefined ? ` neckline $${signal.neckline.toFixed(2)}` : '') +
          (signal.support !== undefined ? ` support $${signal.support.toFixed(2)}` : '') +
          (signal.breakoutRvol !== undefined ? ` rvol ${signal.breakoutRvol.toFixed(2)}x` : '') +
          (signal.reclaimRvol !== undefined ? ` rvol ${signal.reclaimRvol.toFixed(2)}x` : ''),
        );
      } else {
        patternLog.info(`${ticker} — no reversal pattern in lookback ${lookback}`);
      }
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
      origin: 'V1_CORE',
      source: 'core',
      relativeReturn: symbolReturn - benchmarkReturn,
      symbolReturn,
      gapUp,
      gapHeld: true,
      relativeVolume,
      dollarVolume: lastClose * lastVolume,
      lastClose,
      lastOpen: lastBar.OpenPrice,
      adrPct,
      floatShares,
      exchange,
      sma150: weinstein.sma150,
      sma200: weinstein.sma200,
      sma150Slope: weinstein.sma150Slope,
      reversalPattern,
      reversalDetail,
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
  const needed = dailyBarsNeeded(lookbackDays);
  const bars = await fetchDailyBars(BENCHMARK, needed);
  return computeReturn(bars.slice(-lookbackDays));
}

// ---------------------------------------------------------------------------
// 6. Main entry point
// ---------------------------------------------------------------------------

export async function runScreener(): Promise<Watchlist> {
  log.info('Starting post-session screening...');
  const lookbackDays = config.screener.relativeStrengthLookbackDays;

  const universeAssets = await getDynamicUniverseAssets();
  const exchangeBySymbol = new Map(universeAssets.map(a => [a.symbol, a.exchange]));
  const rawUniverse = universeAssets.map(a => a.symbol);

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
    symbol => analyzeSymbol(symbol, benchmarkReturn, lookbackDays, exchangeBySymbol.get(symbol)),
    ANALYSIS_CONCURRENCY,
  );

  const filtered = (candidates.filter(Boolean) as WatchlistSymbol[])
    .sort((a, b) => (b.relativeReturn ?? 0) - (a.relativeReturn ?? 0))
    .slice(0, config.screener.watchlistMaxSize);

  log.info(
    `${filtered.length} symbols retained from ${liquidUniverse.length} analyzed ` +
    `(initial universe: ${rawUniverse.length})`,
  );

  filtered.forEach(s => {
    log.info(
      `  ${s.symbol.padEnd(6)} | alpha: ${((s.relativeReturn ?? 0) * 100).toFixed(2)}% ` +
      `| gap: ${((s.gapUp ?? 0) * 100).toFixed(2)}% | rvol: ${(s.relativeVolume ?? 0).toFixed(2)}x ` +
      `| ADR: ${(s.adrPct ?? 0).toFixed(2)}% ` +
      `| SMA150: $${(s.sma150 ?? 0).toFixed(2)} slope: ${(s.sma150Slope ?? 0).toFixed(3)} ` +
      `| pattern: ${s.reversalPattern ?? '-'} ` +
      `| DV: $${((s.dollarVolume ?? 0) / 1_000_000).toFixed(0)}M ` +
      `| close: $${(s.lastClose ?? 0).toFixed(2)}` +
      (s.exchange ? ` | exch: ${s.exchange}` : ''),
    );
  });

  const existing = await readWatchlist();
  const v2Symbols = (existing?.symbols ?? []).filter(isV2Symbol);

  const watchlist: Watchlist = {
    generatedAt: new Date().toISOString(),
    benchmarkReturn,
    universeSize: rawUniverse.length,
    liquidFiltered: liquidUniverse.length,
    symbols: [...filtered, ...v2Symbols],
  };

  await writeWatchlist(watchlist);
  log.info(
    `Watchlist saved: ${path.resolve(config.paths.watchlist)} ` +
    `(${filtered.length} V1_CORE, ${v2Symbols.length} V2_PLAYMAKER preserved)`,
  );

  void notifyWatchlistSaved(watchlist);

  return watchlist;
}

// Allow direct execution: tsx src/screener.ts
if (require.main === module) {
  runScreener().catch((err: unknown) => {
    console.error(toErrorMessage(err));
    process.exit(1);
  });
}
