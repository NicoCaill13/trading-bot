import { computeSmaAt } from './weinstein';
import type { PriceBar } from './types';

export interface TrendTemplateOpts {
  sma50Period: number;
  sma150Period: number;
  sma200Period: number;
  sma200SlopeBars: number;
  minRsRating: number;
  low52wMultiple: number;
  high52wFloor: number;
  weekSessions: number;
}

export interface TrendTemplateCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface TrendTemplateAssessment {
  passed: boolean;
  checks: TrendTemplateCheck[];
  close: number;
  sma50: number;
  sma150: number;
  sma200: number;
  ema10: number;
  ema20: number;
  low52w: number;
  high52w: number;
  rsRating: number;
}

/** EMA seeded with an SMA of the first `period` closes, then smoothed to the end. */
export function computeEma(closes: readonly number[], period: number): number | null {
  if (period < 1 || closes.length < period) return null;
  let sum = 0;
  for (let i = 0; i < period; i++) {
    if (!(closes[i] > 0)) return null;
    sum += closes[i];
  }
  let ema = sum / period;
  const k = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) {
    if (!(closes[i] > 0)) return null;
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function rangeExtreme(
  bars: readonly PriceBar[],
  sessions: number,
  pick: 'high' | 'low',
): number | null {
  if (bars.length < sessions) return null;
  const slice = bars.slice(-sessions);
  let value = pick === 'high' ? -Infinity : Infinity;
  for (const bar of slice) {
    const price = pick === 'high' ? bar.high : bar.low;
    if (pick === 'high' ? price > value : price < value) value = price;
  }
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Minervini Trend Template, eight checks, all required.
 * Returns null when the history cannot support SMA200 and a 52-week range.
 */
export function assessTrendTemplate(
  bars: readonly PriceBar[],
  rsRating: number,
  opts: TrendTemplateOpts,
): TrendTemplateAssessment | null {
  const closes = bars.map(b => b.close);
  const n = closes.length;
  const needed = Math.max(
    opts.sma200Period + opts.sma200SlopeBars,
    opts.weekSessions,
  );
  if (n < needed) return null;

  const close = closes[n - 1];
  const sma50 = computeSmaAt(closes, n, opts.sma50Period);
  const sma150 = computeSmaAt(closes, n, opts.sma150Period);
  const sma200 = computeSmaAt(closes, n, opts.sma200Period);
  const sma200Prev = computeSmaAt(closes, n - opts.sma200SlopeBars, opts.sma200Period);
  const ema10 = computeEma(closes, 10);
  const ema20 = computeEma(closes, 20);
  const low52w = rangeExtreme(bars, opts.weekSessions, 'low');
  const high52w = rangeExtreme(bars, opts.weekSessions, 'high');
  if (
    sma50 === null ||
    sma150 === null ||
    sma200 === null ||
    sma200Prev === null ||
    ema10 === null ||
    ema20 === null ||
    low52w === null ||
    high52w === null ||
    !(close > 0)
  ) {
    return null;
  }

  const checks: TrendTemplateCheck[] = [
    {
      id: 'price_above_sma150_sma200',
      passed: close > sma150 && close > sma200,
      detail: `close ${close.toFixed(2)} vs SMA150 ${sma150.toFixed(2)} / SMA200 ${sma200.toFixed(2)}`,
    },
    {
      id: 'sma150_above_sma200',
      passed: sma150 > sma200,
      detail: `SMA150 ${sma150.toFixed(2)} vs SMA200 ${sma200.toFixed(2)}`,
    },
    {
      id: 'sma200_rising',
      passed: sma200 > sma200Prev,
      detail: `SMA200 ${sma200.toFixed(2)} vs ${sma200Prev.toFixed(2)} ${opts.sma200SlopeBars} sessions ago`,
    },
    {
      id: 'sma50_above_longer',
      passed: sma50 > sma150 && sma50 > sma200,
      detail: `SMA50 ${sma50.toFixed(2)}`,
    },
    {
      id: 'price_above_sma50',
      passed: close > sma50,
      detail: `close ${close.toFixed(2)} vs SMA50 ${sma50.toFixed(2)}`,
    },
    {
      id: 'above_low_52w',
      passed: close >= opts.low52wMultiple * low52w,
      detail: `close ${close.toFixed(2)} vs ${opts.low52wMultiple}x low ${low52w.toFixed(2)}`,
    },
    {
      id: 'near_high_52w',
      passed: close >= opts.high52wFloor * high52w,
      detail: `close ${close.toFixed(2)} vs ${opts.high52wFloor}x high ${high52w.toFixed(2)}`,
    },
    {
      id: 'rs_rating',
      passed: rsRating >= opts.minRsRating,
      detail: `RS ${rsRating} vs min ${opts.minRsRating}`,
    },
  ];

  return {
    passed: checks.every(c => c.passed),
    checks,
    close,
    sma50,
    sma150,
    sma200,
    ema10,
    ema20,
    low52w,
    high52w,
    rsRating,
  };
}
