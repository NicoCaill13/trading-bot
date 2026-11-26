import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assignRsRatings, distanceFromHigh52w, momentumScore } from '../src/relativeStrength';

describe('momentumScore', () => {
  it('is null below 150 sessions', () => {
    assert.equal(momentumScore(Array.from({ length: 149 }, () => 10)), null);
  });

  it('is positive when the close series rises', () => {
    const closes = Array.from({ length: 260 }, (_, i) => 100 + i);
    const score = momentumScore(closes);
    assert.ok(score !== null && score > 0);
  });

  it('renormalises when the 12-month leg is missing but 150 sessions exist', () => {
    const closes = Array.from({ length: 160 }, (_, i) => 50 + i);
    const score = momentumScore(closes);
    assert.ok(score !== null && score > 0);
  });
});

describe('assignRsRatings', () => {
  it('maps the weakest name to 1 and the strongest to 99', () => {
    const ratings = assignRsRatings([
      { symbol: 'WEAK', score: 1 },
      { symbol: 'MID', score: 2 },
      { symbol: 'STRONG', score: 3 },
    ]);
    assert.equal(ratings.get('WEAK'), 1);
    assert.equal(ratings.get('STRONG'), 99);
    assert.ok((ratings.get('MID') ?? 0) > 1);
    assert.ok((ratings.get('MID') ?? 0) < 99);
  });

  it('rates a single name 99', () => {
    assert.equal(assignRsRatings([{ symbol: 'ONLY', score: 0.1 }]).get('ONLY'), 99);
  });
});

describe('distanceFromHigh52w', () => {
  it('is zero at the high and positive below it', () => {
    const highs = Array.from({ length: 252 }, () => 80);
    highs[10] = 100;
    assert.equal(distanceFromHigh52w(highs, 100), 0);
    assert.ok((distanceFromHigh52w(highs, 75) ?? 0) > 0.2);
  });
});
