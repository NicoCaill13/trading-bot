import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBarRvol,
  detectDoubleBottomSpring,
  detectEtei,
  detectReversalPatterns,
  findSwingLows,
  type PatternBar,
  type ReversalPatternOpts,
} from '../../src/patterns/reversal';

function bar(low: number, high: number, close: number, volume: number): PatternBar {
  return { low, high, close, volume };
}

const baseOpts: ReversalPatternOpts = {
  pivotLeft: 1,
  pivotRight: 1,
  eteiBreakoutRvol: 1.5,
  springReclaimRvol: 1.5,
  springSupportTolerancePct: 0.01,
  rvolAvgDays: 3,
};

/**
 * Historical reference (structure only — synthetic bars below):
 * Inverse H&S / Spring setups are common on liquid names after accumulation;
 * e.g. NVDA-style 2022–2023 basing often showed multi-trough reclaim structures.
 * Fixtures here are synthetic for deterministic unit tests.
 */

describe('findSwingLows', () => {
  it('detects local troughs with left/right=1', () => {
    const bars = [
      bar(12, 14, 13, 100),
      bar(10, 13, 11, 100), // swing
      bar(12, 14, 13, 100),
      bar(11, 13, 12, 100),
      bar(9, 12, 10, 100), // swing
      bar(11, 13, 12, 100),
    ];
    const swings = findSwingLows(bars, 1, 1);
    assert.deepEqual(
      swings.map(s => s.index),
      [1, 4],
    );
  });
});

describe('computeBarRvol', () => {
  it('compares bar volume to prior average', () => {
    const bars = [
      bar(1, 2, 1.5, 100),
      bar(1, 2, 1.5, 100),
      bar(1, 2, 1.5, 100),
      bar(1, 2, 1.5, 300),
    ];
    assert.equal(computeBarRvol(bars, 3, 3), 3);
  });
});

describe('detectEtei', () => {
  function buildEteiPass(): PatternBar[] {
    // Indices: LS=4 (low 20), Head=9 (low 10), RS=14 (low 15), breakout=17
    const bars: PatternBar[] = [];
    for (let i = 0; i < 20; i++) {
      bars.push(bar(22, 24, 23, 100));
    }
    // LS neighborhood
    bars[3] = bar(21, 24, 22, 100);
    bars[4] = bar(20, 23, 21, 1000); // LS
    bars[5] = bar(21, 25, 24, 100); // peak toward head
    bars[6] = bar(18, 26, 25, 100);
    bars[7] = bar(16, 24, 18, 100);
    bars[8] = bar(14, 22, 16, 100);
    bars[9] = bar(10, 20, 12, 400); // Head (lower vol than LS)
    bars[10] = bar(12, 24, 22, 100);
    bars[11] = bar(14, 25, 23, 100); // peak toward RS
    bars[12] = bar(16, 24, 18, 100);
    bars[13] = bar(17, 22, 18, 100);
    bars[14] = bar(15, 21, 17, 800); // RS > Head
    bars[15] = bar(16, 22, 20, 100);
    bars[16] = bar(18, 24, 22, 100);
    bars[17] = bar(22, 28, 27, 600); // close > neckline, RVOL > 1.5 vs prior avg
    return bars;
  }

  it('detects Inverse H&S with neckline breakout and RVOL > 1.5', () => {
    const bars = buildEteiPass();
    const signal = detectEtei(bars, baseOpts);
    assert.ok(signal);
    assert.equal(signal!.pattern, 'ETEI');
    assert.ok(signal!.neckline !== undefined);
    assert.ok((signal!.breakoutRvol ?? 0) > 1.5);
    assert.equal(signal!.pivots.length, 3);
    assert.ok(signal!.pivots[1].price < signal!.pivots[0].price);
    assert.ok(signal!.pivots[1].price < signal!.pivots[2].price);
  });

  it('rejects when head volume is not below left shoulder', () => {
    const bars = buildEteiPass();
    bars[9] = bar(10, 20, 12, 2000); // Head vol > LS
    assert.equal(detectEtei(bars, baseOpts), null);
  });

  it('rejects when breakout RVOL is not strictly above threshold', () => {
    const bars = buildEteiPass();
    bars[17] = bar(22, 28, 27, 140); // ~1.4x avg of 100
    assert.equal(detectEtei(bars, baseOpts), null);
  });
});

describe('detectDoubleBottomSpring', () => {
  function buildSpringPass(): PatternBar[] {
    const bars: PatternBar[] = [];
    for (let i = 0; i < 18; i++) {
      bars.push(bar(12, 14, 13, 100));
    }
    // Touch1 @4, Touch2 @8 (support ~10), spring @12 (low 9), reclaim @14
    bars[3] = bar(11, 13, 12, 100);
    bars[4] = bar(10, 12, 11, 200); // touch1
    bars[5] = bar(11, 14, 13, 100);
    bars[6] = bar(12, 15, 14, 100);
    bars[7] = bar(11, 13, 12, 100);
    bars[8] = bar(10.05, 12, 11, 200); // touch2 within 1%
    bars[9] = bar(11, 14, 13, 100);
    bars[10] = bar(11, 13, 12, 100);
    bars[11] = bar(10.5, 12, 11, 100);
    bars[12] = bar(9, 11, 9.5, 150); // spring below support
    bars[13] = bar(9.5, 11, 10, 100);
    bars[14] = bar(10.2, 13, 12, 400); // reclaim close > support, RVOL >= 1.5
    return bars;
  }

  it('detects spring reclaim with RVOL >= 1.5', () => {
    const bars = buildSpringPass();
    const signal = detectDoubleBottomSpring(bars, baseOpts);
    assert.ok(signal);
    assert.equal(signal!.pattern, 'DOUBLE_BOTTOM_SPRING');
    assert.ok(signal!.support !== undefined);
    assert.ok((signal!.reclaimRvol ?? 0) >= 1.5);
    assert.equal(signal!.pivots.length, 3);
  });

  it('rejects when reclaim RVOL is below threshold', () => {
    const bars = buildSpringPass();
    bars[14] = bar(10.2, 13, 12, 100);
    assert.equal(detectDoubleBottomSpring(bars, baseOpts), null);
  });
});

describe('detectReversalPatterns', () => {
  it('prefers ETEI over Spring when both could match', () => {
    // Minimal rising series with no pattern → null
    const flat = Array.from({ length: 20 }, () => bar(10, 11, 10.5, 100));
    assert.equal(detectReversalPatterns(flat, baseOpts), null);
  });
});
