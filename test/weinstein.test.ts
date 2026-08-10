import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessWeinsteinPhase2,
  computeSma,
  computeSmaAt,
  passesWeinsteinGate,
} from '../src/weinstein';

/** Build a rising close series of length n ending at `end`. */
function risingCloses(n: number, start = 10, step = 0.1): number[] {
  return Array.from({ length: n }, (_, i) => start + i * step);
}

describe('computeSma / computeSmaAt', () => {
  it('averages the last period closes', () => {
    assert.equal(computeSma([1, 2, 3, 4, 5], 3), 4);
  });

  it('returns null when history is short', () => {
    assert.equal(computeSma([1, 2], 3), null);
  });

  it('computes SMA at an earlier end index', () => {
    // closes[0..4]=1..5 ; SMA3 ending at index 3 (exclusive) → (1+2+3)/3 = 2
    assert.equal(computeSmaAt([1, 2, 3, 4, 5], 3, 3), 2);
  });
});

describe('assessWeinsteinPhase2', () => {
  const opts = { sma150Period: 5, sma200Period: 10, slopeLookbackBars: 4 };

  it('returns null when closes < sma200 + slopeLookback', () => {
    // need 14
    assert.equal(assessWeinsteinPhase2(risingCloses(13), opts), null);
  });

  it('passes Phase 2 when price above SMAs and slope >= 0', () => {
    const closes = risingCloses(14, 10, 1);
    const a = assessWeinsteinPhase2(closes, opts);
    assert.ok(a);
    assert.equal(a!.isPhase2, true);
    assert.equal(a!.priceAboveSmas, true);
    assert.equal(a!.slopeNonNegative, true);
    assert.ok(a!.sma150Slope >= 0);
    assert.equal(passesWeinsteinGate(a!), true);
  });

  it('fails when last close is at or below SMA150 or SMA200', () => {
    // Flat series: close == SMA → not strictly above
    const closes = Array.from({ length: 14 }, () => 50);
    const a = assessWeinsteinPhase2(closes, opts);
    assert.ok(a);
    assert.equal(a!.priceAboveSmas, false);
    assert.equal(a!.isPhase2, false);
    assert.equal(passesWeinsteinGate(a!), false);
  });

  it('fails when SMA150 slope is negative', () => {
    // Rise then fall so recent SMA150 is below SMA150 from 4 bars earlier
    const up = risingCloses(10, 10, 2); // 10,12,...,28
    const down = [26, 22, 18, 14]; // sharp drop
    const closes = [...up, ...down];
    assert.equal(closes.length, 14);
    const a = assessWeinsteinPhase2(closes, opts);
    assert.ok(a);
    assert.ok(a!.sma150Slope < 0);
    assert.equal(a!.slopeNonNegative, false);
    assert.equal(a!.isPhase2, false);
  });
});
