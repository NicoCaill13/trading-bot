import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assessIndexRegime, countDistributionDays, combineRegimes } from '../src/marketRegime';
import type { PriceBar } from '../src/types';

function bar(close: number, volume = 1_000_000): PriceBar {
  return { open: close, high: close * 1.01, low: close * 0.99, close, volume };
}

function rising(start: number, sessions: number, step: number): PriceBar[] {
  const bars: PriceBar[] = [];
  for (let i = 0; i < sessions; i++) bars.push(bar(start + i * step));
  return bars;
}

const opts = {
  distributionWindow: 25,
  distributionDeclinePct: 0.002,
  distributionRallyResetPct: 0.05,
  pressureDistributionMin: 5,
  correctionDistributionMin: 7,
  sma50Period: 50,
  sma200Period: 200,
  sma50SlopeBars: 20,
};

describe('countDistributionDays', () => {
  it('counts a decline on higher volume and drops it after a 5% rally', () => {
    const bars = rising(100, 30, 0);
    bars[20] = { open: 100, high: 100, low: 99, close: 99.5, volume: 2_000_000 };
    bars[21] = bar(99.5 * 1.06, 3_000_000);
    assert.equal(countDistributionDays(bars, 25, 0.002, 0.05), 0);
  });

  it('keeps a distribution day that has not been reset', () => {
    const bars = rising(100, 30, 0);
    bars[28] = { open: 100, high: 100, low: 99, close: 99.5, volume: 2_000_000 };
    assert.equal(countDistributionDays(bars, 25, 0.002, 0.05), 1);
  });
});

describe('assessIndexRegime', () => {
  it('reads a confirmed uptrend when price and both averages rise with few distributions', () => {
    const bars = rising(50, 260, 0.2);
    const regime = assessIndexRegime('SPY', bars, opts);
    assert.ok(regime);
    assert.equal(regime.status, 'CONFIRMED_UPTREND');
    assert.equal(regime.recommendedExposurePct, 100);
  });

  it('reads a correction when price is under the 200-day average', () => {
    const bars = rising(100, 240, 0.05);
    for (let i = 0; i < 30; i++) bars.push(bar(40, 1_000_000));
    const regime = assessIndexRegime('QQQ', bars, opts);
    assert.ok(regime);
    assert.equal(regime.status, 'CORRECTION');
    assert.equal(regime.recommendedExposurePct, 0);
  });
});

describe('combineRegimes', () => {
  it('keeps the more defensive index', () => {
    const combined = combineRegimes([
      {
        symbol: 'SPY',
        status: 'CONFIRMED_UPTREND',
        close: 1,
        sma50: 1,
        sma200: 1,
        sma50Rising: true,
        distributionDays: 0,
        recommendedExposurePct: 100,
      },
      {
        symbol: 'QQQ',
        status: 'CORRECTION',
        close: 1,
        sma50: 1,
        sma200: 1,
        sma50Rising: false,
        distributionDays: 8,
        recommendedExposurePct: 0,
      },
    ]);
    assert.equal(combined.status, 'CORRECTION');
    assert.equal(combined.recommendedExposurePct, 0);
  });
});
