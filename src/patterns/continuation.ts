import { computeEma } from '../trendTemplate';
import type { PriceBar, SwingSetup } from '../types';
import {
  averageVolume,
  computeAtrSma,
  resolveSetupState,
  selectStructuralPivot,
  type PivotStateOpts,
} from './bars';

export interface ContinuationOpts extends PivotStateOpts {
  cupMinBars: number;
  cupMaxBars: number;
  cupMinDepthPct: number;
  cupMaxDepthPct: number;
  handleMinBars: number;
  handleMaxBars: number;
  handleMaxRetracePct: number;
  flagImpulseMinPct: number;
  flagImpulseMaxBars: number;
  flagMinBars: number;
  flagMaxBars: number;
  flagVolDryUpRatio: number;
  flagAdrRiskMultiple: number;
  adrLookbackDays: number;
  flatBaseBars: number;
  flatBaseAtrShort: number;
  flatBaseAtrRef: number;
  flatBaseAtrCompressionRatio: number;
  flatBaseMaxRangePct: number;
  maxRiskPct: number;
}

function adrPct(bars: readonly PriceBar[], days: number): number | null {
  if (days < 1 || bars.length < days) return null;
  const slice = bars.slice(-days);
  let sum = 0;
  for (const bar of slice) {
    if (!(bar.close > 0)) return null;
    sum += (bar.high - bar.low) / bar.close;
  }
  return sum / days;
}

function cupWindow(
  bars: readonly PriceBar[],
  cupStart: number,
  cupEnd: number,
  opts: ContinuationOpts,
): { rim: number; cupLow: number; advance: number } | null {
  const cupLen = cupEnd - cupStart + 1;
  if (cupLen < opts.cupMinBars) return null;

  let cupLow = Infinity;
  let cupLowIdx = cupStart;
  let leftRim = -Infinity;
  let rightRim = -Infinity;
  const leftEnd = cupStart + Math.floor(cupLen * 0.35);
  const rightStart = cupEnd - Math.floor(cupLen * 0.35);
  for (let i = cupStart; i <= cupEnd; i++) {
    if (bars[i].low < cupLow) {
      cupLow = bars[i].low;
      cupLowIdx = i;
    }
    if (i <= leftEnd && bars[i].high > leftRim) leftRim = bars[i].high;
    if (i >= rightStart && bars[i].high > rightRim) rightRim = bars[i].high;
  }

  const rel = (cupLowIdx - cupStart) / (cupLen - 1);
  if (rel < 0.25 || rel > 0.75) return null;
  if (!(leftRim > 0) || !(rightRim > 0) || !(cupLow > 0)) return null;

  const rim = Math.min(leftRim, rightRim);
  if (!(rim > cupLow)) return null;
  if (Math.abs(leftRim - rightRim) / rim > 0.08) return null;
  const depth = (rim - cupLow) / rim;
  if (depth < opts.cupMinDepthPct || depth > opts.cupMaxDepthPct) return null;
  return { rim, cupLow, advance: rim - cupLow };
}

/**
 * O'Neil cup with handle. The pivot is the handle high. Only the current bar
 * may be the breakout; an older breakout is rejected by resolveSetupState.
 */
export function detectCupAndHandle(
  bars: readonly PriceBar[],
  opts: ContinuationOpts,
): SwingSetup | null {
  const n = bars.length;
  const minNeed = opts.cupMinBars + opts.handleMinBars;
  if (n < minNeed) return null;

  for (let handleLen = opts.handleMinBars; handleLen <= opts.handleMaxBars; handleLen++) {
    const handleEnd = n - 1;
    const handleStart = handleEnd - handleLen + 1;
    if (handleStart <= 1) continue;

    for (let cupLen = opts.cupMinBars; cupLen <= opts.cupMaxBars; cupLen++) {
      const cupEnd = handleStart - 1;
      const cupStart = cupEnd - cupLen + 1;
      if (cupStart < 0) break;

      const cup = cupWindow(bars, cupStart, cupEnd, opts);
      if (cup === null) continue;

      const structural = selectStructuralPivot(bars, handleStart, handleEnd);
      if (structural === null) continue;
      const handleHigh = structural.price;
      let handleLow = Infinity;
      for (let i = handleStart; i <= handleEnd; i++) {
        if (bars[i].low < handleLow) handleLow = bars[i].low;
      }
      if (handleHigh > cup.rim * 1.001) continue;
      const midpoint = cup.cupLow + 0.5 * cup.advance;
      if (handleLow < midpoint) continue;
      const retrace = (cup.rim - handleLow) / cup.advance;
      if (retrace > opts.handleMaxRetracePct) continue;

      const handleVol = averageVolume(bars, handleStart, Math.min(handleEnd, n - 1));
      const cupVol = averageVolume(bars, cupStart, cupEnd + 1);
      if (!(cupVol > 0) || handleVol > 0.80 * cupVol) continue;

      const resolved = resolveSetupState(bars, structural.index, handleHigh, opts);
      if (resolved === null) continue;
      if (!(handleHigh > handleLow)) continue;

      return {
        pattern: 'CUP_HANDLE',
        state: resolved.state,
        pivot: handleHigh,
        stop: handleLow,
        rvol: resolved.rvol,
        thesis:
          `Cup ${cupLen}d depth ${((cup.rim - cup.cupLow) / cup.rim * 100).toFixed(1)}%, ` +
          `handle retrace ${(retrace * 100).toFixed(1)}%`,
        volumeDryUpRatio: handleVol / cupVol,
        contractionDepths: [retrace],
      };
    }
  }

  return null;
}

/**
 * Kullamägi high tight flag: a >= 30% impulse, then a 5–25 session pause
 * that holds the 20-day EMA, with a stop no wider than 8% or 1.2x ADR.
 */
export function detectKullamagiFlag(
  bars: readonly PriceBar[],
  opts: ContinuationOpts,
): SwingSetup | null {
  const n = bars.length;
  if (n < opts.flagMinBars + 5) return null;
  const closes = bars.map(b => b.close);

  for (let flagLen = opts.flagMinBars; flagLen <= opts.flagMaxBars; flagLen++) {
    const flagEnd = n - 1;
    const flagStart = flagEnd - flagLen + 1;
    if (flagStart <= 1) continue;

    for (let impulseLen = 3; impulseLen <= opts.flagImpulseMaxBars; impulseLen++) {
      const impulseStart = flagStart - impulseLen;
      if (impulseStart < 0) break;
      const startClose = bars[impulseStart].close;
      const impulseClose = bars[flagStart - 1].close;
      if (!(startClose > 0)) continue;
      const impulsePct = impulseClose / startClose - 1;
      if (impulsePct < opts.flagImpulseMinPct) continue;

      let impulseHigh = -Infinity;
      for (let i = impulseStart; i < flagStart; i++) {
        if (bars[i].high > impulseHigh) impulseHigh = bars[i].high;
      }

      const structural = selectStructuralPivot(bars, flagStart, flagEnd);
      if (structural === null) continue;
      const flagHigh = structural.price;
      let flagLow = Infinity;
      for (let i = flagStart; i <= flagEnd; i++) {
        if (bars[i].low < flagLow) flagLow = bars[i].low;
      }
      if (flagHigh > impulseHigh * 1.001) continue;
      if (!(bars[flagEnd].low + 1e-9 >= bars[flagStart].low)) continue;

      const ema20 = computeEma(closes.slice(0, flagEnd + 1), 20);
      if (ema20 === null) continue;
      let held = true;
      for (let i = flagStart; i <= flagEnd; i++) {
        if (bars[i].close < ema20 * 0.98) {
          held = false;
          break;
        }
      }
      if (!held) continue;

      const flagVol = averageVolume(bars, flagStart, flagEnd + 1);
      const impulseVol = averageVolume(bars, impulseStart, flagStart);
      if (!(impulseVol > 0) || flagVol > opts.flagVolDryUpRatio * impulseVol) continue;

      const risk = (flagHigh - flagLow) / flagHigh;
      const adr = adrPct(bars, opts.adrLookbackDays);
      const adrCap = adr === null ? opts.maxRiskPct : opts.flagAdrRiskMultiple * adr;
      if (risk > opts.maxRiskPct && risk > adrCap) continue;

      const resolved = resolveSetupState(bars, structural.index, flagHigh, opts);
      if (resolved === null) continue;

      return {
        pattern: 'KULLAMAGI_FLAG',
        state: resolved.state,
        pivot: flagHigh,
        stop: flagLow,
        rvol: resolved.rvol,
        thesis: `Impulse ${(impulsePct * 100).toFixed(0)}% then ${flagLen}d flag on EMA20`,
        volumeDryUpRatio: flagVol / impulseVol,
        contractionDepths: [risk],
      };
    }
  }

  return null;
}

/** Tight horizontal base. Pivot is the box high, stop is the box low. */
export function detectFlatBase(
  bars: readonly PriceBar[],
  opts: ContinuationOpts,
): SwingSetup | null {
  const n = bars.length;
  const need = Math.max(opts.flatBaseBars, opts.flatBaseAtrRef);
  if (n < need) return null;

  const atrShort = computeAtrSma(bars, n, opts.flatBaseAtrShort);
  const atrRef = computeAtrSma(bars, n, opts.flatBaseAtrRef);
  if (atrShort === null || atrRef === null || !(atrRef > 0)) return null;
  if (atrShort / atrRef > opts.flatBaseAtrCompressionRatio) return null;

  const start = n - opts.flatBaseBars;
  let hi = -Infinity;
  let lo = Infinity;
  let hiIndex = start;
  for (let i = start; i < n; i++) {
    if (bars[i].high > hi) {
      hi = bars[i].high;
      hiIndex = i;
    }
    if (bars[i].low < lo) lo = bars[i].low;
  }
  const mid = (hi + lo) / 2;
  if (!(mid > 0) || (hi - lo) / mid > opts.flatBaseMaxRangePct) return null;

  const structural = selectStructuralPivot(bars, start, n - 1);
  if (structural === null || !(structural.price > lo)) return null;
  const pivot = structural.price;

  const resolved = resolveSetupState(bars, structural.index, pivot, opts);
  if (resolved === null) return null;

  return {
    pattern: 'FLAT_BASE',
    state: resolved.state,
    pivot,
    stop: lo,
    rvol: resolved.rvol,
    thesis: `Flat base ${opts.flatBaseBars}d, ATR compression ${(atrShort / atrRef).toFixed(2)}`,
    volumeDryUpRatio: null,
    contractionDepths: [(pivot - lo) / pivot],
  };
}
