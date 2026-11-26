import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contractionsAreTightening, detectVcp, type VcpOpts } from '../../src/patterns/vcp';
import type { PriceBar } from '../../src/types';

function bar(high: number, low: number, close: number, volume: number): PriceBar {
  return { open: close, high, low, close, volume };
}

const opts: VcpOpts = {
  maxDistanceBelowPct: 0.05,
  maxExtensionPct: 0.05,
  minBreakoutRvol: 1.5,
  rvolAvgDays: 5,
  swingWing: 2,
  minBaseBars: 15,
  maxBaseBars: 80,
  minContractions: 2,
  maxContractions: 5,
  contractionRatio: 0.8,
  maxLastContraction: 0.1,
  dryUpRatio: 0.7,
  dryUpLookback: 20,
};

function vcpSeries(): PriceBar[] {
  const highs = Array.from({ length: 45 }, () => 50);
  const lows = Array.from({ length: 45 }, () => 49);
  const peaks: [number, number][] = [[10, 100], [22, 90], [34, 88]];
  for (const [index, high] of peaks) {
    highs[index] = high;
    lows[index] = high - 1;
  }

  const fade = (from: number, to: number, startHigh: number, endHigh: number, endLow: number): void => {
    const steps = to - from;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      highs[from + i] = startHigh + (endHigh - startHigh) * t;
      lows[from + i] = Math.min(highs[from + i] - 1, endLow + (highs[from + i] - endLow) * (1 - t));
    }
    lows[to - 1] = endLow;
    highs[to - 1] = endLow + 1;
  };
  fade(10, 22, 100, 70, 70);
  fade(22, 34, 90, 82, 82);

  for (let i = 35; i < 45; i++) {
    highs[i] = 86;
    lows[i] = 84;
  }
  const bars = highs.map((high, i) => bar(high, Math.min(lows[i], high - 0.1), Math.min(high - 0.2, 86), i >= 35 ? 40 : 200));
  bars[44] = bar(86.5, 84, 86, 40);
  return bars;
}

describe('contractionsAreTightening', () => {
  it('accepts a shrinking sequence whose last leg is under 10%', () => {
    assert.equal(contractionsAreTightening([0.25, 0.12, 0.05], 0.8, 0.1), true);
  });

  it('rejects a wider second contraction', () => {
    assert.equal(contractionsAreTightening([0.10, 0.12], 0.8, 0.1), false);
  });
});

describe('detectVcp', () => {
  it('flags a forming contraction and ignores a stale breakout', () => {
    const forming = detectVcp(vcpSeries(), opts);
    assert.ok(forming);
    assert.equal(forming.pattern, 'VCP');
    assert.equal(forming.state, 'FORMING_AT_PIVOT');
    assert.ok(forming.contractionDepths.length >= 2);
    assert.ok(forming.volumeDryUpRatio !== null && forming.volumeDryUpRatio <= 0.7);

    const stale = vcpSeries();
    stale[40] = bar(95, 90, 94, 400);
    assert.equal(detectVcp(stale, opts), null);
  });
});
