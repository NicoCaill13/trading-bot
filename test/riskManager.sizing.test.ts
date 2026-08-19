import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  capQtyByMaxNotional,
  capQtyBySettledCash,
  computeRiskBasedQty,
  computeTakeProfitPrice,
  isDailyProfitTargetReached,
  passesMinRiskReward,
  remainingPositionSlots,
} from '../src/riskSizing';

describe('computeRiskBasedQty', () => {
  it('sizes by equity * riskPct / stop distance', () => {
    // equity 100_000, risk 1% = 1000, stop dist 2 → qty 500
    assert.equal(computeRiskBasedQty(100_000, 0.01, 50, 48), 500);
  });

  it('returns 0 when qty would be below 1', () => {
    // risk 100 dollars, stop dist 250 → floor 0
    assert.equal(computeRiskBasedQty(10_000, 0.01, 300, 50), 0);
  });

  it('returns 0 for invalid stop above entry', () => {
    assert.equal(computeRiskBasedQty(100_000, 0.01, 50, 55), 0);
  });
});

describe('computeTakeProfitPrice + passesMinRiskReward', () => {
  it('places take-profit at 2R', () => {
    const entry = 100;
    const stop = 98;
    const tp = computeTakeProfitPrice(entry, stop, 2);
    assert.equal(tp, 104);
    assert.equal(passesMinRiskReward(entry, stop, tp, 2), true);
  });

  it('rejects R:R below minimum', () => {
    assert.equal(passesMinRiskReward(100, 98, 101, 2), false);
  });
});

describe('capQtyBySettledCash', () => {
  it('caps notional by settled cash', () => {
    assert.equal(capQtyBySettledCash(500, 50, 10_000), 200);
  });

  it('returns 0 when cash cannot buy one share', () => {
    assert.equal(capQtyBySettledCash(10, 50, 40), 0);
  });
});

describe('capQtyByMaxNotional', () => {
  it('caps qty so notional <= equity * maxPositionPct', () => {
    // equity 100k, max 40% → 40k notional @ $50 → max 800 shares
    assert.equal(capQtyByMaxNotional(900, 50, 100_000, 0.40), 800);
  });

  it('leaves qty unchanged when already under the ceiling', () => {
    assert.equal(capQtyByMaxNotional(100, 50, 100_000, 0.40), 100);
  });

  it('prevents leverage from a tight-stop inflated risk qty', () => {
    // 5% risk / $0.10 stop on $100 stock → huge share count → capped to 40% equity
    const riskQty = computeRiskBasedQty(100_000, 0.05, 100, 99.9);
    assert.ok(riskQty > 1000);
    const capped = capQtyByMaxNotional(riskQty, 100, 100_000, 0.40);
    assert.equal(capped, 400);
    assert.ok(capped * 100 <= 100_000 * 0.40);
  });
});

describe('remainingPositionSlots', () => {
  it('returns the unused seats in the unified pool', () => {
    assert.equal(remainingPositionSlots(0, 3), 3);
    assert.equal(remainingPositionSlots(2, 3), 1);
    assert.equal(remainingPositionSlots(3, 3), 0);
  });

  it('never goes negative when the book is over the cap', () => {
    assert.equal(remainingPositionSlots(5, 3), 0);
  });
});

describe('isDailyProfitTargetReached', () => {
  it('is inactive when the target is 0', () => {
    assert.equal(isDailyProfitTargetReached(0.05, 0), false);
    assert.equal(isDailyProfitTargetReached(1, 0), false);
  });

  it('fires at or above a positive target', () => {
    assert.equal(isDailyProfitTargetReached(0.01, 0.01), true);
    assert.equal(isDailyProfitTargetReached(0.009, 0.01), false);
  });
});
