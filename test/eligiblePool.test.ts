import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lastDailyBefore, type DailyBar } from '../src/dailyBars';
import { selectEligiblePoolEntries } from '../src/eligiblePool';

function daily(t: string, c: number, v: number): DailyBar {
  return { t, o: c, h: c, l: c, c, v };
}

describe('lastDailyBefore', () => {
  const cutoff = Date.parse('2026-09-03T04:00:00Z');

  it('returns the last bar strictly before cutoff', () => {
    const liq = lastDailyBefore(
      [
        daily('2026-09-01T04:00:00Z', 5.3, 100),
        daily('2026-09-02T04:00:00Z', 5.19, 1_630_731),
        daily('2026-09-03T04:00:00Z', 6.9, 1_000),
      ],
      cutoff,
    );
    assert.deepEqual(liq, { previousClose: 5.19, previousVolume: 1_630_731 });
  });

  it('returns null when volume is missing', () => {
    assert.equal(lastDailyBefore([daily('2026-09-02T04:00:00Z', 5.19, 0)], cutoff), null);
  });
});

describe('selectEligiblePoolEntries', () => {
  const opts = {
    minPrice: 5,
    maxPrice: 100,
    minPrevDollarVolume: 5_000_000,
    maxPrevDollarVolume: 0,
    maxSize: 4000,
  };

  it('keeps CHPT-scale SIP volume and drops IEX-scale volume', () => {
    const daily = new Map([
      ['CHPT', { previousClose: 5.19, previousVolume: 1_630_731 }],
      ['THIN', { previousClose: 5.22, previousVolume: 50_807 }],
    ]);
    const { hits, rejectedLiquidity } = selectEligiblePoolEntries(
      [
        { symbol: 'CHPT', lastPrice: 6.62 },
        { symbol: 'THIN', lastPrice: 6.5 },
      ],
      daily,
      opts,
    );
    assert.deepEqual(hits.map(h => h.symbol), ['CHPT']);
    assert.equal(rejectedLiquidity, 1);
    assert.ok(hits[0]!.prevDollarVolume > 8_000_000);
  });

  it('rejects names outside the price band', () => {
    const daily = new Map([
      ['HOOD', { previousClose: 106.99, previousVolume: 16_000_000 }],
    ]);
    const { hits, rejectedPrice } = selectEligiblePoolEntries(
      [{ symbol: 'HOOD', lastPrice: 113.8 }],
      daily,
      opts,
    );
    assert.equal(hits.length, 0);
    assert.equal(rejectedPrice, 1);
  });

  it('drops the most liquid overflow so mega caps cannot crowd the cap', () => {
    const daily = new Map([
      ['MEGA', { previousClose: 50, previousVolume: 40_000_000 }],
      ['MID', { previousClose: 20, previousVolume: 1_000_000 }],
      ['SMALL', { previousClose: 8, previousVolume: 700_000 }],
    ]);
    const { hits } = selectEligiblePoolEntries(
      [
        { symbol: 'MEGA', lastPrice: 50 },
        { symbol: 'MID', lastPrice: 20 },
        { symbol: 'SMALL', lastPrice: 8 },
      ],
      daily,
      { ...opts, maxSize: 2 },
    );
    assert.deepEqual(hits.map(h => h.symbol), ['SMALL', 'MID']);
  });

  it('applies an optional dollar-volume ceiling', () => {
    const daily = new Map([
      ['MEGA', { previousClose: 50, previousVolume: 40_000_000 }],
      ['CHPT', { previousClose: 5.19, previousVolume: 1_630_731 }],
    ]);
    const { hits, rejectedLiquidity } = selectEligiblePoolEntries(
      [
        { symbol: 'MEGA', lastPrice: 50 },
        { symbol: 'CHPT', lastPrice: 6.62 },
      ],
      daily,
      { ...opts, maxPrevDollarVolume: 100_000_000 },
    );
    assert.deepEqual(hits.map(h => h.symbol), ['CHPT']);
    assert.equal(rejectedLiquidity, 1);
  });
});
