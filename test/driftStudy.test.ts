import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RawBar } from '../scripts/lib/barFetch';
import {
  CONTEXT_LOOKBACK,
  DRIFT_EVENTS,
  accumulateReturns,
  accumulatorMean,
  computeDailyContext,
  emptyAccumulator,
  forwardReturnPct,
  passesPool,
  type DailyContext,
  type SessionOf,
} from '../scripts/lib/driftStudy';

/** Timestamps are "s<index>": the session index is the calendar position. */
const sessionOf: SessionOf = t => {
  const n = Number(t.slice(1));
  return Number.isFinite(n) ? n : undefined;
};

function bar(i: number, o: number, h: number, l: number, c: number, v = 1000): RawBar {
  return { t: `s${i}`, o, h, l, c, v };
}

function flatBars(count: number, price = 10): RawBar[] {
  return Array.from({ length: count }, (_, i) => bar(i, price, price, price, price));
}

describe('computeDailyContext', () => {
  const eventIndex = CONTEXT_LOOKBACK + 4;

  function withEvent(): RawBar[] {
    const bars = flatBars(eventIndex + 1);
    bars[eventIndex] = bar(eventIndex, 11, 11.8, 10.9, 11.5, 5000);
    return bars;
  }

  it('returns null without enough history', () => {
    assert.equal(computeDailyContext(flatBars(CONTEXT_LOOKBACK), CONTEXT_LOOKBACK - 1, sessionOf), null);
  });

  it('measures gap, volume ratio, hold and breakout', () => {
    const ctx = computeDailyContext(withEvent(), eventIndex, sessionOf);
    assert.ok(ctx);
    assert.ok(Math.abs(ctx.gapPct - 10) < 1e-9);
    assert.ok(Math.abs(ctx.volumeRatio - 5) < 1e-9);
    assert.ok(Math.abs(ctx.closeVsOpenPct - (0.5 / 11) * 100) < 1e-9);
    assert.equal(ctx.breaksHigh20, true);
  });

  it('flags a close below the lookback high as no breakout', () => {
    const bars = withEvent();
    bars[eventIndex - 3] = bar(eventIndex - 3, 10, 12.5, 10, 10);
    const ctx = computeDailyContext(bars, eventIndex, sessionOf);
    assert.ok(ctx);
    assert.equal(ctx.breaksHigh20, false);
  });

  it('returns null when the previous session is missing', () => {
    const bars = withEvent();
    bars[eventIndex] = { ...bars[eventIndex], t: `s${eventIndex + 1}` };
    assert.equal(computeDailyContext(bars, eventIndex, sessionOf), null);
  });

  it('returns null when the trailing volume is zero', () => {
    const bars = flatBars(eventIndex + 1).map(b => ({ ...b, v: 0 }));
    assert.equal(computeDailyContext(bars, eventIndex, sessionOf), null);
  });
});

describe('forwardReturnPct', () => {
  const bars = [
    bar(0, 10, 10, 10, 10),
    bar(1, 10, 10, 10, 10),
    bar(2, 20, 21, 19, 22),
    bar(3, 22, 24, 22, 24),
    bar(4, 24, 25, 23, 26),
  ];

  it('buys the next open and sells the close of the horizon session', () => {
    assert.equal(forwardReturnPct(bars, 1, 1, sessionOf), 10);
    assert.equal(forwardReturnPct(bars, 1, 2, sessionOf), 20);
    assert.equal(forwardReturnPct(bars, 1, 3, sessionOf), 30);
  });

  it('returns null past the end of the data', () => {
    assert.equal(forwardReturnPct(bars, 3, 3, sessionOf), null);
  });

  it('returns null when a session is missing inside the holding period', () => {
    const holey = [bars[0], bars[1], bars[2], { ...bars[4], t: 's4' }];
    assert.equal(forwardReturnPct(holey, 1, 3, sessionOf), null);
  });

  it('returns null when the entry session is not the next one', () => {
    const gappy = [bars[0], bars[1], { ...bars[2], t: 's3' }, bars[3], bars[4]];
    assert.equal(forwardReturnPct(gappy, 1, 1, sessionOf), null);
  });
});

describe('passesPool', () => {
  const limits = { minPrice: 5, maxPrice: 100, minDollarVolume: 5_000_000 };

  it('keeps names inside the price band with enough dollar volume', () => {
    assert.equal(passesPool(20, 6_000_000, limits), true);
  });

  it('rejects penny prices, high prices and thin volume', () => {
    assert.equal(passesPool(0.5, 6_000_000, limits), false);
    assert.equal(passesPool(150, 6_000_000, limits), false);
    assert.equal(passesPool(20, 1_000_000, limits), false);
  });
});

describe('DRIFT_EVENTS', () => {
  const base: DailyContext = { gapPct: 0, volumeRatio: 1, closeVsOpenPct: 0, breaksHigh20: false };

  function matching(context: DailyContext): string[] {
    return DRIFT_EVENTS.filter(e => e.matches(context)).map(e => e.name);
  }

  it('matches nothing on an ordinary session', () => {
    assert.deepEqual(matching(base), []);
  });

  it('splits a large volume gap into held and faded, never both', () => {
    const held = matching({ ...base, gapPct: 12, volumeRatio: 4, closeVsOpenPct: 2 });
    const faded = matching({ ...base, gapPct: 12, volumeRatio: 4, closeVsOpenPct: -2 });
    assert.deepEqual(held, ['gap>=8 & vol>=3x & held']);
    assert.deepEqual(faded, ['gap>=8 & vol>=3x & faded']);
  });

  it('requires a gap below 4 percent for the breakout event', () => {
    const noGap = matching({ ...base, breaksHigh20: true, volumeRatio: 3.5, gapPct: 1 });
    const gapped = matching({ ...base, breaksHigh20: true, volumeRatio: 3.5, gapPct: 5, closeVsOpenPct: 1 });
    assert.deepEqual(noGap, ['breakout20 & vol>=3x & gap<4']);
    assert.deepEqual(gapped, ['gap 4-8 & vol>=3x & held']);
  });
});

describe('horizon accumulator', () => {
  it('averages per horizon and skips unavailable returns', () => {
    const acc = emptyAccumulator();
    accumulateReturns(acc, [2, 4, null, 10]);
    accumulateReturns(acc, [4, null, null, 20]);
    assert.equal(accumulatorMean(acc, 0), 3);
    assert.equal(accumulatorMean(acc, 1), 4);
    assert.equal(accumulatorMean(acc, 2), null);
    assert.equal(accumulatorMean(acc, 3), 15);
  });
});
