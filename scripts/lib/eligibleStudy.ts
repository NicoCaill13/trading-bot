/**
 * Pure maths for the "eligible mover" study: which names could have paid +X%
 * from a realistic intraday entry, and which pre-open features separate them
 * from the rest of the tradable pool.
 *
 * No I/O and no config on purpose: the study script injects time handling and
 * data, so every rule here is unit-testable and nothing in src/ depends on it.
 */

import type { RawBar } from './barFetch';

/** Sessions of daily history a feature needs (ATR window + the prior close). */
export const FEATURE_LOOKBACK = 20;

export interface PreOpenFeatures {
  prevClose: number;
  /** Open vs previous close, in percent. Known at 09:30, a proxy for the pre-market gap. */
  gapPct: number;
  /** Previous session close-to-close return, in percent. */
  prevReturnPct: number;
  /** Where the previous close sat in its own range: 0 = low, 1 = high. */
  prevCloseLocation: number;
  /** Mean true range over the lookback, as a percent of the prior close. */
  atrPct20: number;
  prevDollarVolume: number;
  /** Previous session dollar volume over its trailing-window average. */
  dollarVolumeRatio: number;
  /** How far the previous close sits below the lookback high, in percent (>= 0). */
  distanceFromHighPct: number;
}

/**
 * Features computed strictly from sessions before the one being studied, plus
 * that session's open. `history` is chronological and must not include the
 * session itself. Returns null when there is not enough history.
 */
export function computePreOpenFeatures(
  history: readonly RawBar[],
  sessionOpen: number,
): PreOpenFeatures | null {
  if (history.length < FEATURE_LOOKBACK + 1 || !(sessionOpen > 0)) return null;

  const window = history.slice(-(FEATURE_LOOKBACK + 1));
  const last = window[window.length - 1];
  const beforeLast = window[window.length - 2];
  if (!(last.c > 0) || !(beforeLast.c > 0)) return null;

  let trSum = 0;
  let highestHigh = 0;
  let dollarVolumeSum = 0;
  for (let i = 1; i < window.length; i++) {
    const bar = window[i];
    const priorClose = window[i - 1].c;
    const trueRange = Math.max(
      bar.h - bar.l,
      Math.abs(bar.h - priorClose),
      Math.abs(bar.l - priorClose),
    );
    trSum += priorClose > 0 ? trueRange / priorClose : 0;
    highestHigh = Math.max(highestHigh, bar.h);
    dollarVolumeSum += bar.c * bar.v;
  }

  const range = last.h - last.l;
  const averageDollarVolume = dollarVolumeSum / FEATURE_LOOKBACK;
  const prevDollarVolume = last.c * last.v;

  return {
    prevClose: last.c,
    gapPct: ((sessionOpen - last.c) / last.c) * 100,
    prevReturnPct: ((last.c - beforeLast.c) / beforeLast.c) * 100,
    prevCloseLocation: range > 0 ? (last.c - last.l) / range : 0.5,
    atrPct20: (trSum / FEATURE_LOOKBACK) * 100,
    prevDollarVolume,
    dollarVolumeRatio: averageDollarVolume > 0 ? prevDollarVolume / averageDollarVolume : 0,
    distanceFromHighPct: Math.max(0, ((highestHigh - last.c) / last.c) * 100),
  };
}

export type IntradayOutcome = 'target' | 'stop' | 'open';

export interface IntradayResult {
  outcome: IntradayOutcome;
  entryPrice: number;
  /** Best excursion above the entry over the window, in percent. */
  maxFavourablePct: number;
  /**
   * Gross return of the simulated trade, in percent. The target fills at its
   * level, a stop fills at its level or at the bar open when the bar gaps
   * through it, and a trade still open marks to the last close in the window.
   */
  returnPct: number;
}

export interface IntradayOptions {
  /** Minutes since NY midnight of the bar whose close is the entry price. */
  entryMinute: number;
  /** Last minute (inclusive) the position may still be open. */
  endMinute: number;
  targetPct: number;
  stopPct: number;
  /** Injected so this module stays free of timezone handling. */
  minutesOf: (timestamp: string) => number;
}

/**
 * Enters at the close of the entry-minute bar, then walks later bars until the
 * target or the stop is touched. A bar that touches both counts as stopped:
 * intrabar order is unknowable, and the optimistic reading would flatter the
 * very hit rate this study exists to measure.
 */
export function simulateIntraday(
  bars: readonly RawBar[],
  opts: IntradayOptions,
): IntradayResult | null {
  const entryBar = bars.find(b => opts.minutesOf(b.t) === opts.entryMinute);
  if (entryBar === undefined || !(entryBar.c > 0)) return null;

  const entryPrice = entryBar.c;
  const targetPrice = entryPrice * (1 + opts.targetPct / 100);
  const stopPrice = entryPrice * (1 - opts.stopPct / 100);
  let maxFavourablePct = 0;
  let lastClose = entryPrice;
  const returnAt = (price: number): number => ((price - entryPrice) / entryPrice) * 100;

  for (const bar of bars) {
    const minute = opts.minutesOf(bar.t);
    if (minute <= opts.entryMinute || minute > opts.endMinute) continue;

    if (bar.l <= stopPrice) {
      return {
        outcome: 'stop',
        entryPrice,
        maxFavourablePct,
        returnPct: returnAt(Math.min(bar.o, stopPrice)),
      };
    }
    maxFavourablePct = Math.max(maxFavourablePct, returnAt(bar.h));
    if (bar.h >= targetPrice) {
      return { outcome: 'target', entryPrice, maxFavourablePct, returnPct: opts.targetPct };
    }
    lastClose = bar.c;
  }

  return { outcome: 'open', entryPrice, maxFavourablePct, returnPct: returnAt(lastClose) };
}

/** Warrants, rights and units carry a fifth letter W, R or U on US listings. */
export function isDerivativeSymbol(symbol: string): boolean {
  return symbol.length === 5 && /[WRU]$/.test(symbol);
}

export interface OpeningConfirm {
  /** Entry price versus the session's first printed open, in percent. */
  fromOpenPct: number;
  /** Entry price above the volume-weighted average of the opening bars. */
  aboveVwap: boolean;
}

export interface OpeningConfirmOptions {
  openMinute: number;
  entryMinute: number;
  minutesOf: (timestamp: string) => number;
}

/**
 * What the first minutes of the session say about a name, using only bars up to
 * and including the entry bar. Null when the name never printed at the entry
 * minute, since it could not have been bought then.
 */
export function computeOpeningConfirm(
  bars: readonly RawBar[],
  opts: OpeningConfirmOptions,
): OpeningConfirm | null {
  const opening = bars.filter(b => {
    const minute = opts.minutesOf(b.t);
    return minute >= opts.openMinute && minute <= opts.entryMinute;
  });
  const entryBar = opening.find(b => opts.minutesOf(b.t) === opts.entryMinute);
  if (entryBar === undefined || !(opening[0].o > 0)) return null;

  let priceVolume = 0;
  let volume = 0;
  for (const bar of opening) {
    priceVolume += ((bar.h + bar.l + bar.c) / 3) * bar.v;
    volume += bar.v;
  }
  if (volume <= 0) return null;

  return {
    fromOpenPct: ((entryBar.c - opening[0].o) / opening[0].o) * 100,
    aboveVwap: entryBar.c > priceVolume / volume,
  };
}

/**
 * A selection rule over pre-open features. Fixed before the out-of-sample run:
 * editing these after reading out-of-sample results turns the validation into
 * a fit. Every rule added is another comparison the result has to survive.
 */
export interface StudyRule {
  name: string;
  selects: (features: PreOpenFeatures) => boolean;
}

export const STUDY_RULES: readonly StudyRule[] = [
  { name: 'gap>=8', selects: f => f.gapPct >= 8 },
  { name: 'gap>=8 & atr>=6', selects: f => f.gapPct >= 8 && f.atrPct20 >= 6 },
  { name: 'gap>=8 & vol>=2x', selects: f => f.gapPct >= 8 && f.dollarVolumeRatio >= 2 },
  { name: 'atr>=8 & vol>=2x', selects: f => f.atrPct20 >= 8 && f.dollarVolumeRatio >= 2 },
  { name: 'prevRet>=8 & atr>=8', selects: f => f.prevReturnPct >= 8 && f.atrPct20 >= 8 },
  {
    name: 'gap>=4 & atr>=6 & vol>=2x',
    selects: f => f.gapPct >= 4 && f.atrPct20 >= 6 && f.dollarVolumeRatio >= 2,
  },
];

export interface TradeSample {
  session: string;
  symbol: string;
  outcome: IntradayOutcome;
  netReturnPct: number;
}

export interface TradeStats {
  n: number;
  /** Distinct sessions the trades fall in. */
  days: number;
  distinctSymbols: number;
  targetRate: number;
  stopRate: number;
  meanNetPct: number;
  /** Interval assuming independent trades. Too narrow: trades of one day share the market. */
  ci95LowPct: number;
  ci95HighPct: number;
  /** Interval robust to correlation inside a session (cluster-robust standard error). */
  clusteredCi95LowPct: number;
  clusteredCi95HighPct: number;
  /** Share of all positive per-symbol P&L earned by the three best symbols. */
  top3ProfitShare: number;
}

const Z_95 = 1.96;

/**
 * Standard error of the mean when trades are only independent across sessions:
 * the squared per-session sum of centred returns, over n squared.
 */
function clusteredStdError(trades: readonly TradeSample[], mean: number): number {
  const sumBySession = new Map<string, number>();
  for (const t of trades) {
    sumBySession.set(t.session, (sumBySession.get(t.session) ?? 0) + (t.netReturnPct - mean));
  }
  let squares = 0;
  for (const s of sumBySession.values()) squares += s * s;
  return Math.sqrt(squares) / trades.length;
}

export function summarizeTrades(trades: readonly TradeSample[]): TradeStats {
  const n = trades.length;
  if (n === 0) {
    return {
      n: 0,
      days: 0,
      distinctSymbols: 0,
      targetRate: 0,
      stopRate: 0,
      meanNetPct: 0,
      ci95LowPct: 0,
      ci95HighPct: 0,
      clusteredCi95LowPct: 0,
      clusteredCi95HighPct: 0,
      top3ProfitShare: 0,
    };
  }

  const mean = trades.reduce((sum, t) => sum + t.netReturnPct, 0) / n;
  const variance = n > 1
    ? trades.reduce((sum, t) => sum + (t.netReturnPct - mean) ** 2, 0) / (n - 1)
    : 0;
  const halfWidth = Z_95 * Math.sqrt(variance / n);
  const days = new Set(trades.map(t => t.session)).size;
  const clusteredHalfWidth = days > 1 ? Z_95 * clusteredStdError(trades, mean) : halfWidth;

  const bySymbol = new Map<string, number>();
  for (const t of trades) {
    bySymbol.set(t.symbol, (bySymbol.get(t.symbol) ?? 0) + t.netReturnPct);
  }
  const profits = [...bySymbol.values()].filter(v => v > 0).sort((a, b) => b - a);
  const totalProfit = profits.reduce((sum, v) => sum + v, 0);
  const top3 = profits.slice(0, 3).reduce((sum, v) => sum + v, 0);

  return {
    n,
    days,
    distinctSymbols: bySymbol.size,
    targetRate: trades.filter(t => t.outcome === 'target').length / n,
    stopRate: trades.filter(t => t.outcome === 'stop').length / n,
    meanNetPct: mean,
    ci95LowPct: mean - halfWidth,
    ci95HighPct: mean + halfWidth,
    clusteredCi95LowPct: mean - clusteredHalfWidth,
    clusteredCi95HighPct: mean + clusteredHalfWidth,
    top3ProfitShare: totalProfit > 0 ? top3 / totalProfit : 0,
  };
}

export interface BucketRow {
  label: string;
  n: number;
  hits: number;
  precision: number;
  /** Precision over the pool-wide base rate: above 1 means the bucket helps. */
  lift: number;
}

/**
 * Splits rows on ascending `edges` (bucket i is [edges[i-1], edges[i])) and
 * reports hit precision per bucket against the pool-wide base rate.
 */
export function bucketPrecision<T>(
  rows: readonly T[],
  value: (row: T) => number,
  isHit: (row: T) => boolean,
  edges: readonly number[],
  baseRate: number,
): BucketRow[] {
  const counts = Array.from({ length: edges.length + 1 }, () => ({ n: 0, hits: 0 }));

  for (const row of rows) {
    const v = value(row);
    let idx = edges.findIndex(edge => v < edge);
    if (idx === -1) idx = edges.length;
    counts[idx].n++;
    if (isHit(row)) counts[idx].hits++;
  }

  return counts.map((c, i) => {
    const label = i === 0
      ? `< ${edges[0]}`
      : i === edges.length
        ? `>= ${edges[edges.length - 1]}`
        : `${edges[i - 1]} .. ${edges[i]}`;
    const precision = c.n > 0 ? c.hits / c.n : 0;
    return {
      label,
      n: c.n,
      hits: c.hits,
      precision,
      lift: baseRate > 0 ? precision / baseRate : 0,
    };
  });
}
