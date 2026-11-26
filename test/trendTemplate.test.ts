import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assessTrendTemplate, computeEma } from '../src/trendTemplate';
import type { PriceBar } from '../src/types';

const opts = {
  sma50Period: 50,
  sma150Period: 150,
  sma200Period: 200,
  sma200SlopeBars: 20,
  minRsRating: 70,
  low52wMultiple: 1.3,
  high52wFloor: 0.75,
  weekSessions: 252,
};

function series(closes: number[]): PriceBar[] {
  return closes.map(close => ({
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 1_000_000,
  }));
}

describe('computeEma', () => {
  it('matches the seeded SMA when every close is equal', () => {
    assert.equal(computeEma(Array.from({ length: 30 }, () => 20), 10), 20);
  });

  it('returns null when history is shorter than the period', () => {
    assert.equal(computeEma([1, 2, 3], 10), null);
  });
});

describe('assessTrendTemplate', () => {
  it('passes a steady advance with a high relative-strength rating', () => {
    const closes = Array.from({ length: 280 }, (_, i) => 20 + i * 0.15);
    const assessment = assessTrendTemplate(series(closes), 90, opts);
    assert.ok(assessment);
    assert.equal(assessment.passed, true);
    assert.equal(assessment.checks.length, 8);
  });

  it('fails the RS check when the rating is below the floor', () => {
    const closes = Array.from({ length: 280 }, (_, i) => 20 + i * 0.15);
    const assessment = assessTrendTemplate(series(closes), 40, opts);
    assert.ok(assessment);
    assert.equal(assessment.passed, false);
    assert.equal(assessment.checks.find(check => check.id === 'rs_rating')?.passed, false);
  });

  it('returns null without a full 52-week history', () => {
    const closes = Array.from({ length: 220 }, (_, i) => 20 + i);
    assert.equal(assessTrendTemplate(series(closes), 99, opts), null);
  });
});
