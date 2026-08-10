import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessQuoteForWall,
  computeImbalance,
  detectBuyWall,
  quoteToSnapshot,
} from '../src/orderBook';
import type { OrderBookLevel, WsQuoteMessage } from '../src/types';

function levels(sizes: number[], price = 100): OrderBookLevel[] {
  return sizes.map(size => ({ price, size }));
}

function quote(partial: Partial<WsQuoteMessage> & Pick<WsQuoteMessage, 'S'>): WsQuoteMessage {
  return {
    T: 'q',
    bp: 100,
    bs: 1000,
    ap: 100.1,
    as: 1000,
    t: '2026-08-10T14:00:00.000Z',
    ...partial,
  };
}

describe('computeImbalance', () => {
  it('returns ~0.5 for a balanced book', () => {
    const imb = computeImbalance(levels([100]), levels([100]));
    assert.equal(imb, 0.5);
  });

  it('returns >= 0.65 for a bid-heavy book', () => {
    const imb = computeImbalance(levels([650]), levels([350]));
    assert.ok(imb !== null && imb >= 0.65);
    assert.equal(imb, 0.65);
  });

  it('returns null when sizes are zero', () => {
    assert.equal(computeImbalance(levels([0]), levels([0])), null);
    assert.equal(computeImbalance([], []), null);
  });
});

describe('quoteToSnapshot', () => {
  it('maps IEX top-of-book to a single level each side', () => {
    const snap = quoteToSnapshot(quote({ S: 'AAPL', bp: 10, bs: 5, ap: 10.1, as: 3 }));
    assert.equal(snap.bids.length, 1);
    assert.equal(snap.asks.length, 1);
    assert.equal(snap.mid, 10.05);
  });
});

describe('detectBuyWall', () => {
  const thr = { imbalanceThreshold: 0.65, vwapProximityPct: 0.001 };

  it('is true when imbalance and mid are near VWAP', () => {
    assert.equal(detectBuyWall(0.7, 100, 100, thr), true);
  });

  it('is false when imbalance is below threshold', () => {
    assert.equal(detectBuyWall(0.5, 100, 100, thr), false);
  });

  it('is false when mid is far from VWAP', () => {
    assert.equal(detectBuyWall(0.8, 101, 100, thr), false);
  });
});

describe('assessQuoteForWall', () => {
  it('arms a wall for bid-heavy quote near VWAP', () => {
    const signal = assessQuoteForWall(
      quote({ S: 'MSFT', bp: 100, bs: 800, ap: 100.05, as: 200 }),
      100.025,
      { imbalanceThreshold: 0.65, vwapProximityPct: 0.001, assessedAt: 1 },
    );
    assert.equal(signal.wall, true);
    assert.ok(signal.imbalance !== null && signal.imbalance >= 0.65);
    assert.equal(signal.topBid?.size, 800);
  });

  it('does not arm when sizes are balanced', () => {
    const signal = assessQuoteForWall(
      quote({ S: 'MSFT', bp: 100, bs: 500, ap: 100.05, as: 500 }),
      100.025,
      { imbalanceThreshold: 0.65, vwapProximityPct: 0.001, assessedAt: 1 },
    );
    assert.equal(signal.wall, false);
  });
});
