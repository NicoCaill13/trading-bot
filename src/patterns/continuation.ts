/**
 * Pure daily continuation pattern detectors (spec §3.B) — no I/O.
 *
 * Priority: Bull Flag → Cup & Handle → Flat Base.
 * ATR for Flat Base uses SMA of True Range (testable, no external lib).
 */

import type { ContinuationPatternSignal, PivotPoint } from '../types';
import { computeBarRvol, type PatternBar } from './reversal';

export interface ContinuationPatternOpts {
  rvolAvgDays: number;
  bullFlagImpulseMinPct: number;
  bullFlagImpulseMaxBars: number;
  bullFlagMinBars: number;
  bullFlagMaxBars: number;
  bullFlagVolDryUpRatio: number;
  bullFlagBreakoutRvol: number;
  cupMinBars: number;
  cupMaxBars: number;
  cupMaxDepthPct: number;
  handleMaxRetracePct: number;
  handleMaxBars: number;
  flatBaseBars: number;
  flatBaseAtrShort: number;
  flatBaseAtrRef: number;
  flatBaseAtrCompressionRatio: number;
}

function avgVolume(bars: readonly PatternBar[], from: number, toExclusive: number): number {
  const n = toExclusive - from;
  if (n <= 0) return 0;
  let sum = 0;
  for (let i = from; i < toExclusive; i++) sum += bars[i].volume;
  return sum / n;
}

function trueRange(bars: readonly PatternBar[], i: number): number {
  const high = bars[i].high;
  const low = bars[i].low;
  if (i === 0) return high - low;
  const prevClose = bars[i - 1].close;
  return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
}

/** SMA of True Range over `period` bars ending at `endExclusive - 1`. */
export function computeAtrSma(
  bars: readonly PatternBar[],
  endExclusive: number,
  period: number,
): number | null {
  if (period < 1 || endExclusive < period) return null;
  let sum = 0;
  for (let i = endExclusive - period; i < endExclusive; i++) {
    sum += trueRange(bars, i);
  }
  return sum / period;
}

export function detectBullFlag(
  bars: readonly PatternBar[],
  opts: ContinuationPatternOpts,
): ContinuationPatternSignal | null {
  const n = bars.length;
  const minNeed =
    2 + opts.bullFlagMinBars + 1 + opts.rvolAvgDays;
  if (n < minNeed) return null;

  // Search most recent impulse + flag + breakout.
  for (let impulseEnd = n - opts.bullFlagMinBars - 2; impulseEnd >= opts.bullFlagImpulseMaxBars - 1; impulseEnd--) {
    for (
      let impulseLen = 2;
      impulseLen <= opts.bullFlagImpulseMaxBars;
      impulseLen++
    ) {
      const impulseStart = impulseEnd - impulseLen + 1;
      if (impulseStart < 0) continue;
      const startClose = bars[impulseStart].close;
      const endClose = bars[impulseEnd].close;
      if (startClose <= 0) continue;
      const impulsePct = endClose / startClose - 1;
      if (impulsePct < opts.bullFlagImpulseMinPct) continue;

      const impulseHigh = Math.max(
        ...bars.slice(impulseStart, impulseEnd + 1).map(b => b.high),
      );
      const impulseVol = avgVolume(bars, impulseStart, impulseEnd + 1);

      for (
        let flagLen = opts.bullFlagMinBars;
        flagLen <= opts.bullFlagMaxBars;
        flagLen++
      ) {
        const flagStart = impulseEnd + 1;
        const flagEnd = flagStart + flagLen - 1;
        if (flagEnd >= n - 1) continue;

        const flagVol = avgVolume(bars, flagStart, flagEnd + 1);
        if (impulseVol <= 0 || flagVol > opts.bullFlagVolDryUpRatio * impulseVol) {
          continue;
        }

        const flagHigh = Math.max(
          ...bars.slice(flagStart, flagEnd + 1).map(b => b.high),
        );
        // Flag should not make a new high above the impulse high (narrow consolidation).
        if (flagHigh > impulseHigh * 1.001) continue;

        for (let i = flagEnd + 1; i < n; i++) {
          if (bars[i].close <= flagHigh) continue;
          const rvol = computeBarRvol(bars, i, opts.rvolAvgDays);
          if (rvol === null || rvol <= opts.bullFlagBreakoutRvol) continue;

          const pivots: PivotPoint[] = [
            { index: impulseStart, price: bars[impulseStart].close, volume: bars[impulseStart].volume },
            { index: impulseEnd, price: endClose, volume: bars[impulseEnd].volume },
            { index: flagEnd, price: flagHigh, volume: bars[flagEnd].volume },
          ];
          return {
            pattern: 'BULL_FLAG',
            impulsePct,
            flagHigh,
            breakoutRvol: rvol,
            pivots,
          };
        }
      }
    }
  }

  return null;
}

export function detectCupAndHandle(
  bars: readonly PatternBar[],
  opts: ContinuationPatternOpts,
): ContinuationPatternSignal | null {
  const n = bars.length;
  if (n < opts.cupMinBars + 2) return null;

  // Scan cup windows ending near the right edge (leave room for handle).
  for (let cupLen = opts.cupMinBars; cupLen <= opts.cupMaxBars; cupLen++) {
    for (let cupEnd = n - 2; cupEnd >= cupLen - 1; cupEnd--) {
      const cupStart = cupEnd - cupLen + 1;
      const remaining = n - cupEnd - 1;
      if (remaining < 1) continue;

      let cupLow = Infinity;
      let cupLowIdx = cupStart;
      let leftRim = -Infinity;
      let rightRim = -Infinity;
      for (let i = cupStart; i <= cupEnd; i++) {
        if (bars[i].low < cupLow) {
          cupLow = bars[i].low;
          cupLowIdx = i;
        }
        if (i < cupStart + Math.floor(cupLen * 0.35) && bars[i].high > leftRim) {
          leftRim = bars[i].high;
        }
        if (i > cupEnd - Math.floor(cupLen * 0.35) && bars[i].high > rightRim) {
          rightRim = bars[i].high;
        }
      }

      // Cup low should sit in the middle third (U, not V at edge).
      const rel = (cupLowIdx - cupStart) / (cupLen - 1);
      if (rel < 0.25 || rel > 0.75) continue;
      if (leftRim <= 0 || rightRim <= 0) continue;

      const rim = Math.min(leftRim, rightRim);
      if (rim <= cupLow) continue;
      const depth = (rim - cupLow) / rim;
      if (depth <= 0 || depth > opts.cupMaxDepthPct) continue;
      // Lips roughly similar (within 8%) to avoid sharp V / skew.
      if (Math.abs(leftRim - rightRim) / rim > 0.08) continue;

      const advance = rim - cupLow;
      const handleEndMax = Math.min(n - 1, cupEnd + opts.handleMaxBars);
      for (let handleEnd = cupEnd + 1; handleEnd <= handleEndMax; handleEnd++) {
        let handleLow = Infinity;
        for (let i = cupEnd + 1; i <= handleEnd; i++) {
          if (bars[i].low < handleLow) handleLow = bars[i].low;
        }
        if (handleLow >= rim) continue;
        const retrace = (rim - handleLow) / advance;
        if (retrace > opts.handleMaxRetracePct) continue;

        for (let i = handleEnd; i < n; i++) {
          if (bars[i].close <= rim) continue;
          const rvol = computeBarRvol(bars, i, opts.rvolAvgDays);
          return {
            pattern: 'CUP_HANDLE',
            rim,
            breakoutRvol: rvol ?? undefined,
            pivots: [
              { index: cupStart, price: leftRim, volume: bars[cupStart].volume },
              { index: cupLowIdx, price: cupLow, volume: bars[cupLowIdx].volume },
              { index: cupEnd, price: rightRim, volume: bars[cupEnd].volume },
            ],
          };
        }
      }
    }
  }

  return null;
}

export function detectFlatBase(
  bars: readonly PatternBar[],
  opts: ContinuationPatternOpts,
): ContinuationPatternSignal | null {
  const n = bars.length;
  const need = Math.max(opts.flatBaseBars, opts.flatBaseAtrRef);
  if (n < need) return null;

  const end = n;
  const atrShort = computeAtrSma(bars, end, opts.flatBaseAtrShort);
  const atrRef = computeAtrSma(bars, end, opts.flatBaseAtrRef);
  if (atrShort === null || atrRef === null || atrRef <= 0) return null;

  const ratio = atrShort / atrRef;
  if (ratio > opts.flatBaseAtrCompressionRatio) return null;

  // Price should be relatively flat over flatBaseBars (range vs mid <= 12%).
  const windowStart = end - opts.flatBaseBars;
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = windowStart; i < end; i++) {
    if (bars[i].high > hi) hi = bars[i].high;
    if (bars[i].low < lo) lo = bars[i].low;
  }
  const mid = (hi + lo) / 2;
  if (mid <= 0 || (hi - lo) / mid > 0.12) return null;

  return {
    pattern: 'FLAT_BASE',
    atrCompressionRatio: ratio,
    pivots: [
      { index: windowStart, price: lo, volume: bars[windowStart].volume },
      { index: end - 1, price: hi, volume: bars[end - 1].volume },
    ],
  };
}

/** Bull Flag → Cup & Handle → Flat Base. */
export function detectContinuationPatterns(
  bars: readonly PatternBar[],
  opts: ContinuationPatternOpts,
): ContinuationPatternSignal | null {
  return (
    detectBullFlag(bars, opts) ??
    detectCupAndHandle(bars, opts) ??
    detectFlatBase(bars, opts)
  );
}
