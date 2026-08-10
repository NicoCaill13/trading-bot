import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAtrSma,
  detectBullFlag,
  detectContinuationPatterns,
  detectCupAndHandle,
  detectFlatBase,
  type ContinuationPatternOpts,
} from './continuation';
import type { PatternBar } from './reversal';

function bar(low: number, high: number, close: number, volume: number): PatternBar {
  return { low, high, close, volume };
}

const opts: ContinuationPatternOpts = {
  rvolAvgDays: 3,
  bullFlagImpulseMinPct: 0.08,
  bullFlagImpulseMaxBars: 10,
  bullFlagMinBars: 3,
  bullFlagMaxBars: 8,
  bullFlagVolDryUpRatio: 0.60,
  bullFlagBreakoutRvol: 1.5,
  cupMinBars: 10,
  cupMaxBars: 20,
  cupMaxDepthPct: 0.35,
  handleMaxRetracePct: 0.15,
  handleMaxBars: 5,
  flatBaseBars: 10,
  flatBaseAtrShort: 5,
  flatBaseAtrRef: 10,
  flatBaseAtrCompressionRatio: 0.70,
};

describe('computeAtrSma', () => {
  it('returns null when history is short', () => {
    assert.equal(computeAtrSma([bar(1, 2, 1.5, 10)], 1, 5), null);
  });
});

describe('detectBullFlag', () => {
  function buildBullFlagPass(): PatternBar[] {
    const bars: PatternBar[] = [];
    // Warmup for RVOL
    for (let i = 0; i < 5; i++) bars.push(bar(10, 11, 10.5, 200));
    // Impulse: +10% over 5 bars, high volume
    let px = 10;
    for (let i = 0; i < 5; i++) {
      px *= 1.02;
      bars.push(bar(px * 0.99, px * 1.01, px, 300));
    }
    const impulseHigh = bars[bars.length - 1].high;
    // Flag: 4 bars, lower volume, no new high
    for (let i = 0; i < 4; i++) {
      const c = impulseHigh * (0.98 - i * 0.002);
      bars.push(bar(c * 0.99, Math.min(c * 1.005, impulseHigh), c, 100));
    }
    // Breakout with high RVOL
    const flagHigh = Math.max(...bars.slice(-4).map(b => b.high));
    bars.push(bar(flagHigh * 0.99, flagHigh * 1.05, flagHigh * 1.03, 400));
    return bars;
  }

  it('detects impulse + dry-up flag + breakout RVOL', () => {
    const signal = detectBullFlag(buildBullFlagPass(), opts);
    assert.ok(signal);
    assert.equal(signal!.pattern, 'BULL_FLAG');
    assert.ok((signal!.impulsePct ?? 0) >= 0.08);
    assert.ok((signal!.breakoutRvol ?? 0) > 1.5);
  });

  it('rejects when flag volume is not dry', () => {
    const bars = buildBullFlagPass();
    // Inflate flag volumes (indices near end before breakout)
    for (let i = bars.length - 5; i < bars.length - 1; i++) {
      bars[i] = { ...bars[i], volume: 500 };
    }
    assert.equal(detectBullFlag(bars, opts), null);
  });
});

describe('detectCupAndHandle', () => {
  function buildCupPass(): PatternBar[] {
    const bars: PatternBar[] = [];
    for (let i = 0; i < 4; i++) bars.push(bar(19, 20, 19.5, 100));
    // Cup of 12 bars: left rim ~20, trough ~15, right rim ~20
    const cup = [20, 19, 17.5, 16, 15, 15.2, 16, 17.5, 19, 19.5, 20, 20];
    for (const c of cup) {
      bars.push(bar(c * 0.98, c, c * 0.99, 100));
    }
    // Handle: shallow pullback (<15% of 5 advance)
    bars.push(bar(19.2, 19.8, 19.5, 80));
    bars.push(bar(19.0, 19.6, 19.3, 80));
    // Breakout above rim 20
    bars.push(bar(19.8, 21, 20.5, 200));
    return bars;
  }

  it('detects U-cup with handle retrace <= 15% and rim breakout', () => {
    const signal = detectCupAndHandle(buildCupPass(), opts);
    assert.ok(signal);
    assert.equal(signal!.pattern, 'CUP_HANDLE');
    assert.ok((signal!.rim ?? 0) > 0);
  });
});

describe('detectFlatBase', () => {
  it('passes when short ATR is compressed vs reference', () => {
    const bars: PatternBar[] = [];
    // Wide early range builds higher ATR ref (true ranges ~4)
    for (let i = 0; i < 12; i++) {
      const base = 12 + (i % 2) * 0.5;
      bars.push(bar(base - 2, base + 2, base, 100));
    }
    // Tight recent range (true ranges ~0.4)
    for (let i = 0; i < 12; i++) {
      bars.push(bar(11.9, 12.1, 12, 80));
    }
    const signal = detectFlatBase(bars, {
      ...opts,
      flatBaseBars: 12,
      flatBaseAtrShort: 5,
      flatBaseAtrRef: 15,
    });
    assert.ok(signal);
    assert.equal(signal!.pattern, 'FLAT_BASE');
    assert.ok((signal!.atrCompressionRatio ?? 1) <= 0.70);
  });

  it('rejects when ATR is not compressed', () => {
    const bars = Array.from({ length: 20 }, () => bar(10, 14, 12, 100));
    assert.equal(detectFlatBase(bars, opts), null);
  });
});

describe('detectContinuationPatterns', () => {
  it('returns null on flat noise without structure', () => {
    const flat = Array.from({ length: 40 }, () => bar(10, 10.5, 10.2, 100));
    assert.equal(detectContinuationPatterns(flat, opts), null);
  });
});
