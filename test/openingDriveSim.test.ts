import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  simulateTrade,
  type SimOptions,
  type SimTrade,
} from '../scripts/lib/openingDriveSim';
import type { BarData } from '../src/types';

const OPTIONS: SimOptions = {
  spreadPctOneWay: 0,
  maxEntryChasePct: 3.0,
  hardStopFloorPct: 0.025,
  trailTriggerPct: 0.08,
  trailPct: 0.04,
  timeStopMinutes: 20,
  hardCloseMinutes: 15 * 60 + 55,
};

/** 09:30 EST is 13:30 UTC in August (EDT). */
function bar(
  minuteOffset: number,
  open: number,
  high: number,
  low: number,
  close: number,
): BarData {
  const base = Date.parse('2026-08-12T13:30:00.000Z');
  return {
    open,
    high,
    low,
    close,
    volume: 100_000,
    timestamp: new Date(base + minuteOffset * 60_000).toISOString(),
  };
}

/** signalIndex 0 with an override 10% under the fill keeps the floor out of the way. */
const SIGNAL = { signalIndex: 0, signalClose: 10, stopPriceOverride: 9 };

function run(
  bars: readonly BarData[],
  options: Partial<SimOptions> = {},
  signal = SIGNAL,
): SimTrade {
  const outcome = simulateTrade(
    'TEST',
    '2026-08-12',
    bars,
    signal,
    { ...OPTIONS, ...options },
    () => 100,
  );
  assert.equal(outcome.kind, 'trade', `expected a trade, got ${outcome.kind}`);
  if (outcome.kind !== 'trade') throw new Error('unreachable');
  return outcome.trade;
}

describe('simulateTrade — entry', () => {
  it('fills at the next bar open, never the signal close', () => {
    const trade = run([bar(0, 10, 10, 10, 10), bar(1, 10.2, 10.5, 10.1, 10.4)]);
    assert.equal(trade.entryPrice, 10.2);
  });

  it('rejects when the fill bar gaps past the anti-chase cap', () => {
    const outcome = simulateTrade(
      'TEST',
      '2026-08-12',
      [bar(0, 10, 10, 10, 10), bar(1, 10.4, 10.5, 10.3, 10.4)],
      SIGNAL,
      OPTIONS,
      () => 100,
    );
    assert.equal(outcome.kind, 'rejected');
    if (outcome.kind === 'rejected') assert.equal(outcome.reason, 'anti_chase');
  });

  it('rejects when the signal bar is the last bar of the session', () => {
    const outcome = simulateTrade(
      'TEST',
      '2026-08-12',
      [bar(0, 10, 10, 10, 10)],
      SIGNAL,
      OPTIONS,
      () => 100,
    );
    assert.equal(outcome.kind, 'rejected');
    if (outcome.kind === 'rejected') assert.equal(outcome.reason, 'no_fill_bar');
  });

  it('widens a structural stop that sits inside the hard floor', () => {
    // Override 0.1% under the fill: the 2.5% floor must win.
    const trade = run(
      [bar(0, 10, 10, 10, 10), bar(1, 10, 10.1, 9.99, 10.05)],
      {},
      { signalIndex: 0, signalClose: 10, stopPriceOverride: 9.99 },
    );
    assert.equal(trade.stopDistance, 0.25);
  });
});

describe('simulateTrade — exits', () => {
  it('fills a stop-loss at the stop price when the bar trades through it', () => {
    const trade = run([
      bar(0, 10, 10, 10, 10),
      bar(1, 10, 10.1, 9.95, 10),
      bar(2, 9.8, 9.9, 8.5, 8.6),
    ]);
    assert.equal(trade.exitReason, 'stop-loss');
    assert.equal(trade.exitPrice, 9);
    assert.equal(trade.gappedThroughStop, false);
  });

  it('fills at the open, and flags it, when the stop is jumped', () => {
    const trade = run([
      bar(0, 10, 10, 10, 10),
      bar(1, 10, 10.1, 9.95, 10),
      bar(2, 8.5, 8.6, 8.4, 8.5),
    ]);
    assert.equal(trade.exitReason, 'stop-loss');
    assert.equal(trade.exitPrice, 8.5);
    assert.equal(trade.gappedThroughStop, true);
  });

  it('scores a bar that touched both the high and the stop as a loss', () => {
    // High would arm the trail, low breaks the stop: 1-min bars do not order them.
    const trade = run([
      bar(0, 10, 10, 10, 10),
      bar(1, 10, 13, 8.9, 9),
    ]);
    assert.equal(trade.exitReason, 'stop-loss');
    assert.equal(trade.pnlR, -1);
  });

  it('arms the trail at the trigger and exits it below the high water mark', () => {
    const trade = run([
      bar(0, 10, 10, 10, 10),
      bar(1, 10, 12.5, 10, 12.4),
      bar(2, 12.4, 12.4, 10.5, 10.6),
    ]);
    assert.equal(trade.exitReason, 'trailing-stop');
    assert.equal(trade.exitPrice, 12.5 * (1 - OPTIONS.trailPct));
    assert.equal(trade.mfePct, 0.25);
  });

  it('leaves the trail unarmed below the trigger, so the original stop holds', () => {
    const trade = run([
      bar(0, 10, 10, 10, 10),
      bar(1, 10, 10.7, 10, 10.6),
      bar(2, 10.6, 10.6, 8.9, 9),
    ]);
    assert.equal(trade.exitReason, 'stop-loss');
    assert.equal(trade.exitPrice, 9);
  });

  it('ratchets the trail up and never back down', () => {
    const trade = run([
      bar(0, 10, 10, 10, 10),
      bar(1, 10, 13, 10, 12.9),
      bar(2, 12.9, 15, 12.5, 14.9),
      bar(3, 14.9, 14.9, 13, 13.1),
    ]);
    assert.equal(trade.exitReason, 'trailing-stop');
    assert.equal(trade.exitPrice, 15 * (1 - OPTIONS.trailPct));
  });

  it('fires the time stop only when the position never went positive', () => {
    const bars = [bar(0, 10, 10, 10, 10)];
    for (let i = 1; i <= 22; i++) bars.push(bar(i, 10, 10, 9.9, 9.95));
    const trade = run(bars);
    assert.equal(trade.exitReason, 'time-stop');
    assert.equal(trade.heldMinutes, 20);
  });

  it('holds past the time stop once the position has shown a gain', () => {
    const bars = [bar(0, 10, 10, 10, 10)];
    bars.push(bar(1, 10, 10.5, 10, 10.4));
    for (let i = 2; i <= 22; i++) bars.push(bar(i, 10.4, 10.4, 10.2, 10.3));
    const trade = run(bars);
    assert.notEqual(trade.exitReason, 'time-stop');
  });

  it('flattens at the hard close', () => {
    const openMinutes = 13 * 60 + 30;
    const hardClose = 19 * 60 + 55;
    const bars = [bar(0, 10, 10, 10, 10), bar(1, 10, 10.5, 10, 10.4)];
    bars.push(bar(hardClose - openMinutes, 10.4, 10.6, 10.3, 10.5));
    const trade = run(bars);
    assert.equal(trade.exitReason, 'hard-close');
    assert.equal(trade.exitPrice, 10.5);
  });
});

describe('simulateTrade — costs and instrumentation', () => {
  it('charges the spread on both legs', () => {
    const trade = run(
      [bar(0, 10, 10, 10, 10), bar(1, 10, 10.5, 10, 10.4), bar(2, 10.4, 10.4, 10.2, 10.3)],
      { spreadPctOneWay: 0.005, hardCloseMinutes: 13 * 60 + 32 },
    );
    assert.equal(trade.entryPrice, 10 * 1.005);
    assert.equal(trade.exitPrice, 10.3 * 0.995);
  });

  it('counts missing bars as halt exposure', () => {
    const trade = run([
      bar(0, 10, 10, 10, 10),
      bar(1, 10, 10.2, 10, 10.1),
      bar(9, 10.1, 10.3, 10, 10.2),
      bar(20, 10.2, 10.3, 8.9, 9),
    ]);
    assert.equal(trade.haltGapCount, 2);
  });

  it('reports pnl in R against the actual stop distance', () => {
    const trade = run([bar(0, 10, 10, 10, 10), bar(1, 10, 10.1, 9, 9)]);
    assert.equal(trade.riskDollars, 100);
    assert.equal(trade.pnlR, -1);
  });
});
