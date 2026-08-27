import path from 'path';
import alpaca from './alpacaClient';
import config, { getSma150SlopeLookbackBars } from './config';
import { createFloatProvider, isFloatFilterActive } from './floatProvider';
import { createLogger } from './logger';
import { queryRequiredWatchlistTradingDay } from './marketCalendar';
import { estCalendarDayKey, toErrorMessage } from './utils';
import { applySplits, loadSplitIndex, type SplitIndex } from './corporateActions';
import { readEodBars, writeEodBars } from './eodCache';
import { readWatchlist, writeWatchlist, isV2Symbol } from './watchlistIO';
import { notifyWatchlistSaved } from './notificationManager';
import {
  compareWatchlistRank,
  computeAdrPct,
  isAllowedExchange,
  isEtfLikeProduct,
  passesAdrGate,
  passesDollarVolume,
  passesFloatGate,
  passesPriceBand,
} from './screenerMath';
import {
  assessWeinsteinPhase2,
  passesWeinsteinGate,
} from './weinstein';
import {
  assessStraightRun,
  computeVolumeRatio,
  describeStraightRunRejection,
  type StraightRunBar,
} from './straightRun';
import { detectReversalPatterns } from './patterns/reversal';
import { detectContinuationPatterns } from './patterns/continuation';
import { createNewsProvider } from './newsProvider';
import { filterWatchlistByBullishCatalyst } from './sentiment';
import type {
  Watchlist,
  WatchlistSymbol,
  ReversalPatternSignal,
  ContinuationPatternSignal,
} from './types';
import type { AlpacaBar } from '@alpacahq/alpaca-trade-api';

const log = createLogger('SCREENER');
const weinsteinLog = createLogger('WEINSTEIN');
const patternLog = createLogger('PATTERN');
const straightRunLog = createLogger('STRAIGHT_RUN');
const floatProvider = createFloatProvider();
const newsProvider = createNewsProvider();

const BENCHMARK = 'SPY';
const SNAPSHOT_BATCH_SIZE = 100;
const ANALYSIS_CONCURRENCY = 5;

function dailyBarsNeeded(lookbackDays: number): number {
  const weinsteinBars = config.screener.weinsteinGateEnabled
    ? config.screener.sma200Period + getSma150SlopeLookbackBars()
    : 0;
  const adrBars = config.screener.adrGateEnabled ? config.screener.adrLookbackDays : 0;
  return Math.max(
    lookbackDays + config.screener.volumeAverageDays + 2,
    adrBars,
    weinsteinBars,
    2,
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
  let rejectedEtf = 0;

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
    if (isEtfLikeProduct({ name: a.name, attributes: a.attributes })) {
      rejectedEtf++;
      continue;
    }
    filtered.push({ symbol: a.symbol, exchange: a.exchange });
  }

  log.info(
    `Raw universe: ${assets.length} assets | ` +
    `${filtered.length} after filtering (tradable + marginable + clean + exchange + common equity) | ` +
    `rejects exchange=${rejectedExchange} dirty=${rejectedDirty} not_tradable=${rejectedNotTradable} etf=${rejectedEtf}`,
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
    `(close $${config.screener.minClosePrice}–$${config.screener.maxClosePrice}, ` +
    `DV ≥ $${(config.screener.minDollarVolume / 1_000_000).toFixed(1)}M)...`,
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

        if (!passesPriceBand(close, config.screener.minClosePrice, config.screener.maxClosePrice)) {
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

interface FunnelTally {
  clearedLiquidity: number;
  clearedAdr: number;
  clearedPhase2: number;
}

function emptyFunnelTally(): FunnelTally {
  return { clearedLiquidity: 0, clearedAdr: 0, clearedPhase2: 0 };
}

// ~252 trading days per 365 calendar days; the extra margin absorbs holiday
// clusters so a 200-day SMA window never falls short and silently rejects a name.
const CALENDAR_DAYS_PER_TRADING_DAY = 1.75;

/**
 * The window every symbol of a run shares, plus the split index used to rescale
 * it. Resolved once in `runScreener`: computing it per symbol would let a run
 * straddling midnight give the first and last symbol different histories.
 */
interface EodContext {
  startDay: string;
  tradingDay: string;
  splits: SplitIndex;
}

/**
 * Window bounds as NY calendar days.
 *
 * `toISOString` was used here before and is a UTC projection: a run at 20:00
 * EST is already 00:00 UTC the next day, so two runs minutes apart on either
 * side of that boundary requested different windows. When the boundary landed
 * on a split ex-date the 200-bar window slid across it and the SMA200 jumped
 * (NFLX, 10-for-1 on 2025-11-17).
 */
function parseNyCalendarDay(day: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) {
    throw new Error(`[SCREENER] Invalid EOD trading day ${day}`);
  }
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function resolveEodWindow(
  limit: number,
  tradingDay: string,
): { startDay: string; tradingDay: string } {
  // Civil-date carrier: YYYY-MM-DD already resolved in NY. Local midnight of
  // that date is used only for day arithmetic — not as an instant.
  const end = parseNyCalendarDay(tradingDay);
  const start = new Date(end.getTime());
  start.setDate(start.getDate() - Math.ceil(limit * CALENDAR_DAYS_PER_TRADING_DAY) + 1);
  return { startDay: estCalendarDayKey(start), tradingDay };
}

async function fetchDailyBarsFromApi(
  symbol: string,
  eod: EodContext,
): Promise<AlpacaBar[]> {
  const bars: AlpacaBar[] = [];
  const iter = alpaca.getBarsV2(symbol, {
    start: eod.startDay,
    end: eod.tradingDay,
    timeframe: '1Day',
    feed: config.alpaca.dataFeed,
    // Raw when we own the rescaling: the broker's own split adjustment is
    // applied relative to the requested range, so it moves when the range does.
    adjustment: eod.splits.mode === 'own' ? 'raw' : 'split',
  });

  for await (const bar of iter) {
    bars.push(bar);
  }

  return bars;
}

async function fetchDailyBars(
  symbol: string,
  limit: number,
  eod: EodContext,
): Promise<AlpacaBar[]> {
  const cached = await readEodBars(eod.tradingDay, symbol, eod.startDay, eod.splits.mode);
  if (cached !== null) return cached.slice(-limit);

  const raw = await fetchDailyBarsFromApi(symbol, eod);
  const adjusted = eod.splits.mode === 'own'
    ? applySplits(raw, eod.splits.getSplits(symbol))
    : raw;

  await writeEodBars(eod.tradingDay, symbol, eod.startDay, eod.splits.mode, adjusted);

  return adjusted.slice(-limit);
}

function toStraightRunBar(bar: AlpacaBar): StraightRunBar {
  return {
    high: bar.HighPrice,
    low: bar.LowPrice,
    close: bar.ClosePrice,
    volume: bar.Volume,
  };
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
  benchmark: BenchmarkStats,
  lookbackDays: number,
  exchange: string | undefined,
  tally: FunnelTally,
  eod: EodContext,
): Promise<WatchlistSymbol | null> {
  const ticker =
    typeof symbol === 'string' && symbol.trim().length > 0 ? symbol.trim() : null;

  if (!ticker) {
    log.warn('REJECTED — missing ticker (undefined snapshot Symbol — check preFilterByLiquidity)');
    return null;
  }

  try {
    const needed = dailyBarsNeeded(lookbackDays);
    const bars = await fetchDailyBars(ticker, needed, eod);

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

    if (!passesPriceBand(lastClose, config.screener.minClosePrice, config.screener.maxClosePrice)) {
      log.info(
        `${ticker} REJECTED — price $${lastClose.toFixed(2)} ` +
        `outside $${config.screener.minClosePrice}–$${config.screener.maxClosePrice}`,
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

    tally.clearedLiquidity++;

    const adrPct = computeAdrPct(
      bars.map(b => ({ high: b.HighPrice, low: b.LowPrice, close: b.ClosePrice })),
      config.screener.adrLookbackDays,
    );
    if (config.screener.adrGateEnabled) {
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
    }

    tally.clearedAdr++;

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
    const weinstein = config.screener.weinsteinGateEnabled
      ? assessWeinsteinPhase2(closes, {
          sma150Period: config.screener.sma150Period,
          sma200Period: config.screener.sma200Period,
          slopeLookbackBars: getSma150SlopeLookbackBars(),
        })
      : null;
    if (config.screener.weinsteinGateEnabled) {
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
    }
    tally.clearedPhase2++;

    const straightRun = assessStraightRun(
      bars.map(toStraightRunBar),
      config.straightRun,
      benchmark.volumeRatio,
    );
    if (straightRun === null) {
      straightRunLog.info(`${ticker} — insufficient history for the run window`);
    } else if (straightRun.isStraightRun) {
      straightRunLog.info(
        `${ticker} TAGGED — ${straightRun.trigger} ` +
        `| streak ${straightRun.consecutiveUpDays}d ` +
        `| run ${(straightRun.runReturnPct * 100).toFixed(2)}% ` +
        `| dd ${(straightRun.drawdownPct * 100).toFixed(2)}% ` +
        `| rel. RVOL ${straightRun.marketRelativeRvol.toFixed(2)}x ` +
        `(abs ${straightRun.volumeRatio.toFixed(2)}x) ` +
        `| score ${straightRun.score.toFixed(2)}`,
      );
    } else {
      straightRunLog.info(
        `${ticker} — not a straight run: ` +
        describeStraightRunRejection(straightRun, config.straightRun),
      );
    }

    let reversalPattern: WatchlistSymbol['reversalPattern'];
    let reversalDetail: ReversalPatternSignal | undefined;
    let continuationPattern: WatchlistSymbol['continuationPattern'];
    let continuationDetail: ContinuationPatternSignal | undefined;
    if (config.screener.patternFilterEnabled) {
      const lookback = Math.min(config.screener.patternLookbackBars, bars.length);
      const slice = bars.slice(-lookback);
      const ohlcv = slice.map(b => ({
        high: b.HighPrice,
        low: b.LowPrice,
        close: b.ClosePrice,
        volume: b.Volume,
      }));
      const reversalSignal = detectReversalPatterns(ohlcv, {
        pivotLeft: config.screener.patternPivotLeft,
        pivotRight: config.screener.patternPivotRight,
        eteiBreakoutRvol: config.screener.eteiBreakoutRvol,
        springReclaimRvol: config.screener.springReclaimRvol,
        springSupportTolerancePct: config.screener.springSupportTolerancePct,
        rvolAvgDays: config.screener.patternRvolAvgDays,
      });
      if (reversalSignal) {
        reversalPattern = reversalSignal.pattern;
        reversalDetail = reversalSignal;
        const pivots = reversalSignal.pivots.map(p => p.price.toFixed(2)).join('/');
        patternLog.info(
          `${ticker} PASS — ${reversalSignal.pattern} pivots ${pivots}` +
          (reversalSignal.neckline !== undefined ? ` neckline $${reversalSignal.neckline.toFixed(2)}` : '') +
          (reversalSignal.support !== undefined ? ` support $${reversalSignal.support.toFixed(2)}` : '') +
          (reversalSignal.breakoutRvol !== undefined ? ` rvol ${reversalSignal.breakoutRvol.toFixed(2)}x` : '') +
          (reversalSignal.reclaimRvol !== undefined ? ` rvol ${reversalSignal.reclaimRvol.toFixed(2)}x` : ''),
        );
      } else {
        patternLog.info(`${ticker} — no reversal pattern in lookback ${lookback}`);
      }

      const continuationSignal = detectContinuationPatterns(ohlcv, {
        rvolAvgDays: config.screener.patternRvolAvgDays,
        bullFlagImpulseMinPct: config.screener.bullFlagImpulseMinPct,
        bullFlagImpulseMaxBars: config.screener.bullFlagImpulseMaxBars,
        bullFlagMinBars: config.screener.bullFlagMinBars,
        bullFlagMaxBars: config.screener.bullFlagMaxBars,
        bullFlagVolDryUpRatio: config.screener.bullFlagVolDryUpRatio,
        bullFlagBreakoutRvol: config.screener.bullFlagBreakoutRvol,
        cupMinBars: config.screener.cupMinBars,
        cupMaxBars: config.screener.cupMaxBars,
        cupMaxDepthPct: config.screener.cupMaxDepthPct,
        handleMaxRetracePct: config.screener.handleMaxRetracePct,
        handleMaxBars: config.screener.handleMaxBars,
        flatBaseBars: config.screener.flatBaseBars,
        flatBaseAtrShort: config.screener.flatBaseAtrShort,
        flatBaseAtrRef: config.screener.flatBaseAtrRef,
        flatBaseAtrCompressionRatio: config.screener.flatBaseAtrCompressionRatio,
      });
      if (continuationSignal) {
        continuationPattern = continuationSignal.pattern;
        continuationDetail = continuationSignal;
        patternLog.info(
          `${ticker} PASS — ${continuationSignal.pattern}` +
          (continuationSignal.impulsePct !== undefined
            ? ` impulse ${(continuationSignal.impulsePct * 100).toFixed(1)}%`
            : '') +
          (continuationSignal.flagHigh !== undefined
            ? ` flagHigh $${continuationSignal.flagHigh.toFixed(2)}`
            : '') +
          (continuationSignal.rim !== undefined
            ? ` rim $${continuationSignal.rim.toFixed(2)}`
            : '') +
          (continuationSignal.atrCompressionRatio !== undefined
            ? ` atrRatio ${continuationSignal.atrCompressionRatio.toFixed(2)}`
            : '') +
          (continuationSignal.breakoutRvol !== undefined
            ? ` rvol ${continuationSignal.breakoutRvol.toFixed(2)}x`
            : ''),
        );
      } else {
        patternLog.info(`${ticker} — no continuation pattern in lookback ${lookback}`);
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

    return {
      symbol: ticker,
      origin: 'V1_CORE',
      source: 'core',
      relativeReturn: symbolReturn - benchmark.ret,
      symbolReturn,
      gapUp,
      gapHeld: isGapHeld(bars),
      relativeVolume,
      dollarVolume: lastClose * lastVolume,
      lastClose,
      lastOpen: lastBar.OpenPrice,
      adrPct: adrPct ?? undefined,
      floatShares,
      exchange,
      sma150: weinstein?.sma150,
      sma200: weinstein?.sma200,
      sma150Slope: weinstein?.sma150Slope,
      reversalPattern,
      reversalDetail,
      continuationPattern,
      continuationDetail,
      isStraightRun: straightRun?.isStraightRun ?? false,
      straightRunDetail: straightRun ?? undefined,
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

/**
 * Benchmark figures every candidate is scored against: relative strength on the
 * return, and the market-wide volume trend the straight-run conviction check is
 * normalised by.
 */
interface BenchmarkStats {
  ret: number;
  volumeRatio: number;
}

async function computeBenchmarkStats(
  lookbackDays: number,
  eod: EodContext,
): Promise<BenchmarkStats | null> {
  log.info(`Fetching benchmark data for ${BENCHMARK}...`);
  const needed = dailyBarsNeeded(lookbackDays);
  const bars = await fetchDailyBars(BENCHMARK, needed, eod);

  const ret = computeReturn(bars.slice(-lookbackDays));
  if (ret === null) return null;

  const volumeRatio = computeVolumeRatio(
    bars.map(b => toStraightRunBar(b)),
    config.straightRun.minDays,
    config.straightRun.rvolBaselineDays,
  );
  if (volumeRatio === null) {
    log.warn(`${BENCHMARK}: volume ratio unavailable — STRAIGHT_RUN tagging disabled this run`);
  }

  return { ret, volumeRatio: volumeRatio ?? 0 };
}

// ---------------------------------------------------------------------------
// 6. Main entry point
// ---------------------------------------------------------------------------

export async function runScreener(asOfTradingDay?: string): Promise<Watchlist> {
  log.info('Starting post-session screening...');
  const lookbackDays = config.screener.relativeStrengthLookbackDays;

  const tradingDay = asOfTradingDay ?? await queryRequiredWatchlistTradingDay();
  if (tradingDay === null) {
    throw new Error('[SCREENER] Cannot resolve required EOD trading day — calendar unavailable');
  }

  const window = resolveEodWindow(dailyBarsNeeded(lookbackDays), tradingDay);
  const splits = await loadSplitIndex(window.startDay, window.tradingDay);
  const eod: EodContext = { ...window, splits };
  log.info(
    `EOD window ${window.startDay} → ${window.tradingDay} (NY) ` +
    `| adjustment: ${splits.mode}`,
  );

  const universeAssets = await getDynamicUniverseAssets();
  const exchangeBySymbol = new Map(universeAssets.map(a => [a.symbol, a.exchange]));
  const rawUniverse = universeAssets.map(a => a.symbol);

  const liquidUniverse = await preFilterByLiquidity(rawUniverse);

  if (liquidUniverse.length === 0) {
    throw new Error('[SCREENER] Empty universe after liquidity pre-filter — aborting without writing watchlist');
  }

  const benchmark = await computeBenchmarkStats(lookbackDays, eod);
  if (benchmark === null) {
    throw new Error('[SCREENER] Failed to compute benchmark return — aborting without writing watchlist');
  }

  log.info(
    `${BENCHMARK} return over ${lookbackDays}d: ${(benchmark.ret * 100).toFixed(2)}% ` +
    `| volume trend ${benchmark.volumeRatio.toFixed(2)}x`,
  );

  log.info(`Full analysis on ${liquidUniverse.length} qualified symbols...`);
  const funnel = emptyFunnelTally();
  const candidates = await throttledMap(
    liquidUniverse,
    symbol => analyzeSymbol(
      symbol,
      benchmark,
      lookbackDays,
      exchangeBySymbol.get(symbol),
      funnel,
      eod,
    ),
    ANALYSIS_CONCURRENCY,
  );

  const filtered = (candidates.filter(Boolean) as WatchlistSymbol[])
    .sort(compareWatchlistRank);

  // When catalyst gate is on, score a wider alpha pool then hard-filter; else top-N only.
  const poolSize = config.sentiment.enabled
    ? Math.min(filtered.length, Math.max(config.screener.watchlistMaxSize * 3, 75))
    : config.screener.watchlistMaxSize;
  const pool = filtered.slice(0, poolSize);
  const withCatalyst = await filterWatchlistByBullishCatalyst(pool, newsProvider);
  const retained = withCatalyst.slice(0, config.screener.watchlistMaxSize);

  log.info(
    `Funnel — universe: ${rawUniverse.length} ` +
    `-> price/volume: ${funnel.clearedLiquidity} ` +
    `-> ADR: ${funnel.clearedAdr} ` +
    `-> Phase 2: ${funnel.clearedPhase2} ` +
    `-> watchlist: ${retained.length}` +
    (config.sentiment.enabled
      ? ` (catalyst gate ${withCatalyst.length}/${pool.length})`
      : '') +
    ` | STRAIGHT_RUN: ${retained.filter(s => s.isStraightRun).length}`,
  );

  retained.forEach(s => {
    log.info(
      `  ${s.symbol.padEnd(6)} | alpha: ${((s.relativeReturn ?? 0) * 100).toFixed(2)}% ` +
      `| gap: ${((s.gapUp ?? 0) * 100).toFixed(2)}% | rvol: ${(s.relativeVolume ?? 0).toFixed(2)}x ` +
      `| ADR: ${(s.adrPct ?? 0).toFixed(2)}% ` +
      `| SMA150: $${(s.sma150 ?? 0).toFixed(2)} slope: ${(s.sma150Slope ?? 0).toFixed(3)} ` +
      `| pattern: ${s.reversalPattern ?? '-'} / ${s.continuationPattern ?? '-'} ` +
      `| DV: $${((s.dollarVolume ?? 0) / 1_000_000).toFixed(0)}M ` +
      `| close: $${(s.lastClose ?? 0).toFixed(2)}` +
      (s.exchange ? ` | exch: ${s.exchange}` : '') +
      (s.sentiment ? ` | sent: ${s.sentiment}` : '') +
      (s.isStraightRun ? ` | RUN ${(s.straightRunDetail?.score ?? 0).toFixed(2)}` : ''),
    );
  });

  const existing = await readWatchlist();
  const v2Symbols = (existing?.symbols ?? []).filter(isV2Symbol);

  const watchlist: Watchlist = {
    generatedAt: new Date().toISOString(),
    tradingDay: eod.tradingDay,
    benchmarkReturn: benchmark.ret,
    universeSize: rawUniverse.length,
    liquidFiltered: liquidUniverse.length,
    symbols: [...retained, ...v2Symbols],
  };

  await writeWatchlist(watchlist);
  log.info(
    `Watchlist saved: ${path.resolve(config.paths.watchlist)} ` +
    `(${retained.length} V1_CORE, ${v2Symbols.length} V2_PLAYMAKER preserved)`,
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
