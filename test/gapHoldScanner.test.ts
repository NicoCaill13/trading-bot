import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyGapHoldTrack,
  rankGapHoldMovers,
  type GapHoldScannerOpts,
} from '../src/gapHoldScanner';
import type { OpeningMover } from '../src/openingScanner';

const OPTS: GapHoldScannerOpts = {
  minPrice: 5,
  maxPrice: 100,
  minRthDollarVolume: 100_000,
  maxSymbols: 6,
  pinned: new Set<string>(),
  minOvernightGapPct: 0.08,
  maxOvernightGapPct: 0.55,
  continuationMaxGapPct: 0.12,
  minYesterdayReturnPct: 0.03,
  minYesterdayCloseLocation: 0.60,
  gapFillTolerancePct: 0.01,
  newsSlots: 3,
  continuationSlots: 2,
};

function mover(partial: Partial<OpeningMover> & Pick<OpeningMover, 'symbol'>): OpeningMover {
  return {
    last: 20,
    sessionOpen: 20,
    previousClose: 18,
    rthDollarVolume: 1_000_000,
    extensionPct: 0,
    overnightGapPct: null,
    yesterdayReturnPct: null,
    yesterdayCloseLocation: null,
    previousHigh: null,
    previousOpen: null,
    sessionLow: null,
    ...partial,
  };
}

describe('classifyGapHoldTrack', () => {
  it('tags a 33% overnight hold as news_gap (CHPT)', () => {
    const hit = mover({
      symbol: 'CHPT',
      last: 12.2,
      sessionOpen: 12.0,
      previousClose: 9.0,
      overnightGapPct: (12.0 - 9.0) / 9.0,
      rthDollarVolume: 5_000_000,
      sessionLow: 11.98,
    });
    assert.equal(classifyGapHoldTrack(hit, OPTS), 'news_gap');
  });

  it('tags a small-gap yesterday-winner as continuation (AEHR)', () => {
    const hit = mover({
      symbol: 'AEHR',
      last: 26.2,
      sessionOpen: 25.5,
      previousClose: 25.0,
      overnightGapPct: (25.5 - 25.0) / 25.0,
      yesterdayReturnPct: 0.08,
      yesterdayCloseLocation: 0.85,
      previousHigh: 25.4,
      rthDollarVolume: 8_000_000,
      sessionLow: 25.45,
    });
    assert.equal(classifyGapHoldTrack(hit, OPTS), 'continuation');
  });

  it('drops a 3% open-extension with no yesterday run', () => {
    const hit = mover({
      symbol: 'DRIFT',
      last: 10.4,
      sessionOpen: 10.3,
      previousClose: 10.0,
      overnightGapPct: 0.03,
      yesterdayReturnPct: 0.005,
      yesterdayCloseLocation: 0.4,
      previousHigh: 10.2,
    });
    assert.equal(classifyGapHoldTrack(hit, OPTS), null);
  });

  it('drops a 79% lottery gap above the cap (MIMI-style)', () => {
    const hit = mover({
      symbol: 'MIMI',
      last: 12.0,
      sessionOpen: 11.5,
      previousClose: 6.5,
      overnightGapPct: 0.77,
      rthDollarVolume: 2_000_000,
      sessionLow: 11.4,
    });
    assert.equal(classifyGapHoldTrack(hit, OPTS), null);
  });
});

describe('rankGapHoldMovers', () => {
  it('keeps the news gapper and the continuation, drops the drifter', () => {
    const selected = rankGapHoldMovers(
      [
        mover({
          symbol: 'CHPT',
          last: 12.2,
          sessionOpen: 12.0,
          previousClose: 9.0,
          overnightGapPct: 0.33,
          rthDollarVolume: 5_000_000,
          sessionLow: 11.98,
        }),
        mover({
          symbol: 'AEHR',
          last: 26.2,
          sessionOpen: 25.5,
          previousClose: 25.0,
          overnightGapPct: 0.02,
          yesterdayReturnPct: 0.08,
          yesterdayCloseLocation: 0.85,
          previousHigh: 25.4,
          rthDollarVolume: 8_000_000,
          sessionLow: 25.45,
        }),
        mover({
          symbol: 'DRIFT',
          last: 10.4,
          sessionOpen: 10.3,
          previousClose: 10.0,
          overnightGapPct: 0.03,
          yesterdayReturnPct: 0,
          previousHigh: 10.2,
        }),
      ],
      OPTS,
    );
    assert.deepEqual(selected.map(s => s.symbol), ['CHPT', 'AEHR']);
    assert.equal(selected[0]?.track, 'news_gap');
    assert.equal(selected[1]?.track, 'continuation');
  });
});
