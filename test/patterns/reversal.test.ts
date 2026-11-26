import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectWyckoffSpring, type ReversalOpts } from '../../src/patterns/reversal';
import { detectEpisodicPivot } from '../../src/patterns/episodicPivot';
import type { PriceBar } from '../../src/types';

function bar(close: number, high: number, low: number, volume: number): PriceBar {
  return { open: close, high, low, close, volume };
}

const reversal: ReversalOpts = {
  swingWing: 2,
  springReclaimRvol: 1.5,
  springSupportTolerancePct: 0.02,
  eteiBreakoutRvol: 1.5,
  rvolAvgDays: 3,
  maxAgeBars: 2,
  maxExtensionPct: 0.05,
};

describe('detectWyckoffSpring', () => {
  it('requires the reclaim to be the current bar or the one before', () => {
    const bars: PriceBar[] = [];
    const support = 10;
    for (let i = 0; i < 20; i++) bars.push(bar(support + 0.4, support + 0.5, support + 0.2, 100));
    bars[5] = bar(support, support + 0.2, support, 80);
    bars[12] = bar(support, support + 0.2, support * 0.99, 80);
    bars.push(bar(support - 0.2, support, support - 0.4, 90));
    bars.push(bar(support + 0.3, support + 0.4, support - 0.1, 250));
    const setup = detectWyckoffSpring(bars, reversal);
    assert.ok(setup);
    assert.equal(setup.pattern, 'WYCKOFF_SPRING');
    assert.equal(setup.state, 'FRESH_BREAKOUT');
  });
});

describe('detectEpisodicPivot', () => {
  it('accepts a gap that closes high on a volume multiple', () => {
    const bars: PriceBar[] = [];
    for (let i = 0; i < 51; i++) bars.push(bar(10, 10.2, 9.8, 100));
    bars.push({ open: 11.2, high: 12, low: 11, close: 11.8, volume: 400 });
    const setup = detectEpisodicPivot(bars, {
      minGapPct: 0.10,
      minRvol: 3,
      rvolAvgDays: 50,
      minCloseLocation: 0.65,
    });
    assert.ok(setup);
    assert.equal(setup.pattern, 'EPISODIC_PIVOT');
    assert.equal(setup.stop, 11);
    assert.ok((setup.rvol ?? 0) >= 3);
  });

  it('rejects a gap that closes at the low', () => {
    const bars: PriceBar[] = [];
    for (let i = 0; i < 51; i++) bars.push(bar(10, 10.2, 9.8, 100));
    bars.push({ open: 11.2, high: 12, low: 11, close: 11.1, volume: 400 });
    assert.equal(detectEpisodicPivot(bars, {
      minGapPct: 0.10,
      minRvol: 3,
      rvolAvgDays: 50,
      minCloseLocation: 0.65,
    }), null);
  });
});
