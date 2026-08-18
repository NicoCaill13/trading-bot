/**
 * Daily "straight-line run" detection (#29) — pure, no I/O.
 *
 * Identifies names that grind up session after session without ever offering a
 * VWAP pullback, so Core V7 structurally never fires on them. The result is an
 * annotation on the watchlist, never a Core gate: it only arms the isolated
 * Opening Drive entry path.
 */

import type { StraightRunAssessment, StraightRunTrigger } from './types';

export interface StraightRunBar {
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface StraightRunOptions {
  /** Length of the run window, in sessions. */
  minDays: number;
  /** Deepest tolerated close-to-close decline inside the window. */
  maxDrawdownPct: number;
  /**
   * Floor on the market-relative volume ratio, not the absolute one. 1.0 means
   * "traded at least in line with the market's own volume trend".
   */
  minMarketRelativeRvol: number;
  /** Sessions immediately preceding the window used as the volume baseline. */
  rvolBaselineDays: number;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Mean volume of the last `windowDays` sessions over the mean of the
 * `baselineDays` sessions immediately preceding them.
 *
 * Exported so the benchmark ratio is produced by the same code as the symbol
 * ratio: the two are divided by one another, so any asymmetry between them
 * would silently bias every tag.
 */
export function computeVolumeRatio(
  bars: readonly StraightRunBar[],
  windowDays: number,
  baselineDays: number,
): number | null {
  if (windowDays < 1 || baselineDays < 1) return null;
  if (bars.length < windowDays + baselineDays) return null;

  const windowStart = bars.length - windowDays;
  const baselineVolume = mean(
    bars.slice(windowStart - baselineDays, windowStart).map(b => b.volume),
  );
  if (baselineVolume <= 0) return null;

  return mean(bars.slice(windowStart).map(b => b.volume)) / baselineVolume;
}

function countConsecutiveUpDays(bars: readonly StraightRunBar[]): number {
  let streak = 0;
  for (let i = bars.length - 1; i > 0; i--) {
    if (bars[i].close <= bars[i - 1].close) break;
    streak++;
  }
  return streak;
}

/**
 * Deepest peak-to-trough decline measured on closes, anchored on the close that
 * precedes the window.
 *
 * Closes, not highs and lows, on purpose: the Core screener already demands
 * ADR > 4%, so the average candidate's daily range alone exceeds the 4% default
 * cap. Measuring intraday extremes would make the gate mathematically
 * unreachable — every name would be rejected by its own volatility.
 */
function computeCloseDrawdownPct(closes: readonly number[]): number {
  let peak = closes[0];
  let worst = 0;
  for (const close of closes) {
    if (close > peak) peak = close;
    if (peak > 0) {
      const decline = (peak - close) / peak;
      if (decline > worst) worst = decline;
    }
  }
  return worst;
}

/**
 * Quality blend, weighted towards straightness because that is the property the
 * Opening Drive path actually depends on. Volume and momentum only break ties
 * between names that are already smooth.
 */
function computeScore(
  drawdownPct: number,
  marketRelativeRvol: number,
  runReturnPct: number,
  opts: StraightRunOptions,
): number {
  const straightness = 1 - clamp01(drawdownPct / opts.maxDrawdownPct);
  const conviction = clamp01(marketRelativeRvol / (opts.minMarketRelativeRvol * 2));
  // Normalised against a 1%-per-session pace.
  const momentum = clamp01(runReturnPct / (opts.minDays * 0.01));
  return clamp01(0.5 * straightness + 0.25 * conviction + 0.25 * momentum);
}

/**
 * Returns null when history is too short to judge; otherwise always returns an
 * assessment so callers can log why a near-miss failed.
 *
 * `benchmarkVolumeRatio` is the index's own window/baseline volume ratio for the
 * same run, produced by `computeVolumeRatio`. A non-positive value degrades the
 * conviction check to zero rather than passing everything through.
 */
export function assessStraightRun(
  bars: readonly StraightRunBar[],
  opts: StraightRunOptions,
  benchmarkVolumeRatio: number,
): StraightRunAssessment | null {
  const { minDays, rvolBaselineDays, maxDrawdownPct, minMarketRelativeRvol } = opts;
  if (minDays < 2 || rvolBaselineDays < 1 || maxDrawdownPct <= 0) return null;
  if (bars.length < minDays + rvolBaselineDays) return null;

  const windowStart = bars.length - minDays;
  const window = bars.slice(windowStart);
  const anchorClose = bars[windowStart - 1].close;
  const lastClose = bars[bars.length - 1].close;

  if (anchorClose <= 0 || lastClose <= 0) return null;

  const consecutiveUpDays = countConsecutiveUpDays(bars);
  const runReturnPct = (lastClose - anchorClose) / anchorClose;
  const drawdownPct = computeCloseDrawdownPct([anchorClose, ...window.map(b => b.close)]);

  const volumeRatio = computeVolumeRatio(bars, minDays, rvolBaselineDays) ?? 0;
  const marketRelativeRvol = benchmarkVolumeRatio > 0
    ? volumeRatio / benchmarkVolumeRatio
    : 0;

  // Highs of the window excluding the last bar: the breakout bar cannot clear
  // its own high.
  const priorHighs = window.slice(0, -1).map(b => b.high);
  const brokeRange = priorHighs.length > 0 && lastClose > Math.max(...priorHighs);

  const trigger: StraightRunTrigger | null = consecutiveUpDays >= minDays
    ? 'consecutive_closes'
    : brokeRange
      ? 'range_breakout'
      : null;

  const isStraightRun =
    trigger !== null &&
    drawdownPct <= maxDrawdownPct &&
    marketRelativeRvol >= minMarketRelativeRvol &&
    runReturnPct > 0;

  return {
    isStraightRun,
    trigger,
    consecutiveUpDays,
    runReturnPct,
    drawdownPct,
    volumeRatio,
    marketRelativeRvol,
    score: isStraightRun
      ? computeScore(drawdownPct, marketRelativeRvol, runReturnPct, opts)
      : 0,
  };
}

export function describeStraightRunRejection(
  assessment: StraightRunAssessment,
  opts: StraightRunOptions,
): string {
  const reasons: string[] = [];
  if (assessment.trigger === null) {
    reasons.push(
      `no trigger (streak ${assessment.consecutiveUpDays}/${opts.minDays}, no range breakout)`,
    );
  }
  if (assessment.drawdownPct > opts.maxDrawdownPct) {
    reasons.push(
      `drawdown ${(assessment.drawdownPct * 100).toFixed(2)}% ` +
      `> ${(opts.maxDrawdownPct * 100).toFixed(1)}%`,
    );
  }
  if (assessment.marketRelativeRvol < opts.minMarketRelativeRvol) {
    reasons.push(
      `rel. RVOL ${assessment.marketRelativeRvol.toFixed(2)}x ` +
      `< ${opts.minMarketRelativeRvol.toFixed(1)}x ` +
      `(absolute ${assessment.volumeRatio.toFixed(2)}x)`,
    );
  }
  if (assessment.runReturnPct <= 0) {
    reasons.push(`run return ${(assessment.runReturnPct * 100).toFixed(2)}% <= 0`);
  }
  return reasons.join('; ');
}
