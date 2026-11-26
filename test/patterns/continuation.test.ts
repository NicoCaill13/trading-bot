import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectCupAndHandle,
  detectFlatBase,
  detectKullamagiFlag,
  type ContinuationOpts,
} from '../../src/patterns/continuation';
import type { PriceBar } from '../../src/types';

function bar(close: number, high = close, low = close, volume = 100): PriceBar {
  return { open: close, high, low, close, volume };
}

const opts: ContinuationOpts = {
  maxDistanceBelowPct: 0.05,
  maxExtensionPct: 0.05,
  minBreakoutRvol: 1.5,
  rvolAvgDays: 5,
  cupMinBars: 20,
  cupMaxBars: 30,
  cupMinDepthPct: 0.12,
  cupMaxDepthPct: 0.35,
  handleMinBars: 5,
  handleMaxBars: 8,
  handleMaxRetracePct: 0.12,
  flagImpulseMinPct: 0.30,
  flagImpulseMaxBars: 15,
  flagMinBars: 5,
  flagMaxBars: 8,
  flagVolDryUpRatio: 0.6,
  flagAdrRiskMultiple: 1.2,
  adrLookbackDays: 10,
  flatBaseBars: 12,
  flatBaseAtrShort: 5,
  flatBaseAtrRef: 12,
  flatBaseAtrCompressionRatio: 0.7,
  flatBaseMaxRangePct: 0.12,
  maxRiskPct: 0.08,
};

describe('detectCupAndHandle', () => {
  it('finds a handle sitting just under the pivot', () => {
    const bars: PriceBar[] = [];
    for (let i = 0; i < 21; i++) {
      const x = (i - 10) / 10;
      const close = 100 - 30 * (1 - x * x);
      bars.push(bar(close, close + 1, close - 1, 200));
    }
    for (let i = 0; i < 6; i++) {
      bars.push(bar(98.4, 99, 98, 80));
    }
    const setup = detectCupAndHandle(bars, opts);
    assert.ok(setup);
    assert.equal(setup.pattern, 'CUP_HANDLE');
    assert.equal(setup.state, 'FORMING_AT_PIVOT');
  });

  it('rejects a breakout that is no longer the current bar', () => {
    const bars: PriceBar[] = [];
    for (let i = 0; i < 21; i++) {
      const x = (i - 10) / 10;
      const close = 100 - 30 * (1 - x * x);
      bars.push(bar(close, close + 1, close - 1, 200));
    }
    for (let i = 0; i < 5; i++) bars.push(bar(98, 99, 97, 80));
    bars.push(bar(104, 105, 100, 500));
    bars.push(bar(110, 112, 108, 100));
    assert.equal(detectCupAndHandle(bars, opts), null);
  });
});

describe('detectKullamagiFlag', () => {
  it('finds a tight flag after a 30% impulse', () => {
    const bars: PriceBar[] = [];
    for (let i = 0; i < 25; i++) bars.push(bar(10 + i * 0.05, 10.2 + i * 0.05, 9.9 + i * 0.05, 100));
    const base = bars[bars.length - 1].close;
    for (let i = 1; i <= 8; i++) {
      const close = base * (1 + 0.05 * i);
      bars.push(bar(close, close + 0.1, close - 0.1, 300));
    }
    const flag = bars[bars.length - 1].close;
    for (let i = 0; i < 6; i++) {
      bars.push(bar(flag * 0.99, flag * 1.005, flag * 0.985, 80));
    }
    const setup = detectKullamagiFlag(bars, opts);
    assert.ok(setup);
    assert.equal(setup.pattern, 'KULLAMAGI_FLAG');
    assert.ok(setup.pivot > setup.stop);
  });
});

describe('detectFlatBase', () => {
  it('returns null when the range is wide', () => {
    const bars: PriceBar[] = [];
    for (let i = 0; i < 40; i++) {
      const close = i % 2 === 0 ? 10 : 14;
      bars.push(bar(close, close + 0.2, close - 0.2, 100));
    }
    assert.equal(detectFlatBase(bars, opts), null);
  });
});
