import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RawBar } from '../scripts/lib/barFetch';
import type { SessionOf } from '../scripts/lib/driftStudy';
import {
  FORMATION_SESSIONS,
  LIQUIDITY_WINDOW,
  MIN_LIQUIDITY_BARS,
  SKIP_SESSIONS,
  bottomCandidates,
  compoundedReturnPct,
  decileSize,
  holdReturnPct,
  indexBySession,
  meanReturnPct,
  momentumScorePct,
  passesLiquidity,
  rebalanceSessions,
  topCandidates,
  type Candidate,
} from '../scripts/lib/momentumStudy';

/** Timestamps are "s<index>": the session index is the calendar position. */
const sessionOf: SessionOf = t => {
  const n = Number(t.slice(1));
  return Number.isFinite(n) ? n : undefined;
};

function bar(i: number, o: number, c: number, v = 1_000_000): RawBar {
  return { t: `s${i}`, o, h: Math.max(o, c), l: Math.min(o, c), c, v };
}

function series(count: number, price: (i: number) => number, volume = 1_000_000): RawBar[] {
  return Array.from({ length: count }, (_, i) => bar(i, price(i), price(i), volume));
}

describe('indexBySession', () => {
  it('keys bars by calendar position and ignores bars outside the calendar', () => {
    const map = indexBySession([bar(3, 1, 1), { ...bar(4, 1, 1), t: 'unknown' }], sessionOf);
    assert.deepEqual([...map.keys()], [3]);
  });
});

describe('momentumScorePct', () => {
  const session = FORMATION_SESSIONS + 10;

  it('uses the close FORMATION sessions ago and the close SKIP sessions ago', () => {
    const bars = indexBySession(
      series(session + 1, i => (i === session - FORMATION_SESSIONS ? 10 : i === session - SKIP_SESSIONS ? 15 : 12)),
      sessionOf,
    );
    const score = momentumScorePct(bars, session);
    assert.ok(score !== null && Math.abs(score - 50) < 1e-9);
  });

  it('ignores the most recent month, so a late spike does not count', () => {
    const calm = series(session + 1, () => 10);
    const spiked = series(session + 1, i => (i > session - SKIP_SESSIONS ? 100 : 10));
    assert.equal(momentumScorePct(indexBySession(calm, sessionOf), session), 0);
    assert.equal(momentumScorePct(indexBySession(spiked, sessionOf), session), 0);
  });

  it('is null when either end of the window is missing', () => {
    const bars = series(session + 1, () => 10).filter(b => b.t !== `s${session - FORMATION_SESSIONS}`);
    assert.equal(momentumScorePct(indexBySession(bars, sessionOf), session), null);
    assert.equal(momentumScorePct(indexBySession(series(30, () => 10), sessionOf), 29), null);
  });
});

describe('passesLiquidity', () => {
  const limits = { minPrice: 10, minAverageDollarVolume: 20_000_000 };
  const session = LIQUIDITY_WINDOW + 5;

  it('accepts a priced, liquid name', () => {
    const bars = indexBySession(series(session + 1, () => 50, 1_000_000), sessionOf);
    assert.equal(passesLiquidity(bars, session, limits), true);
  });

  it('rejects a low price even with heavy volume', () => {
    const bars = indexBySession(series(session + 1, () => 5, 50_000_000), sessionOf);
    assert.equal(passesLiquidity(bars, session, limits), false);
  });

  it('rejects thin dollar volume', () => {
    const bars = indexBySession(series(session + 1, () => 50, 100_000), sessionOf);
    assert.equal(passesLiquidity(bars, session, limits), false);
  });

  it('rejects a name that printed on too few sessions of the window', () => {
    const keep = LIQUIDITY_WINDOW - MIN_LIQUIDITY_BARS - 1;
    const bars = series(session + 1, () => 50).filter(
      b => sessionOf(b.t)! > session - 1 - keep || sessionOf(b.t)! === session,
    );
    assert.equal(passesLiquidity(indexBySession(bars, sessionOf), session, limits), false);
  });

  it('rejects a name with no bar on the rebalance session', () => {
    const bars = series(session + 1, () => 50).filter(b => b.t !== `s${session}`);
    assert.equal(passesLiquidity(indexBySession(bars, sessionOf), session, limits), false);
  });
});

describe('holdReturnPct', () => {
  it('buys the next open and sells the close of session+hold', () => {
    const bars = indexBySession(
      [bar(0, 9, 9), bar(1, 10, 11), bar(2, 11, 12), bar(3, 12, 13)],
      sessionOf,
    );
    const ret = holdReturnPct(bars, 0, 3);
    assert.ok(ret !== null && Math.abs(ret - 30) < 1e-9);
  });

  it('does not let the rebalance-session close leak into the entry', () => {
    const bars = indexBySession([bar(0, 9, 999), bar(1, 10, 10), bar(2, 10, 11)], sessionOf);
    const ret = holdReturnPct(bars, 0, 2);
    assert.ok(ret !== null && Math.abs(ret - 10) < 1e-9);
  });

  it('is null when the exit bar is missing, not zero', () => {
    const bars = indexBySession([bar(0, 9, 9), bar(1, 10, 10)], sessionOf);
    assert.equal(holdReturnPct(bars, 0, 3), null);
    assert.equal(holdReturnPct(bars, 0, 0), null);
  });
});

describe('rebalanceSessions', () => {
  it('steps by the hold and keeps only periods that fit before the last session', () => {
    assert.deepEqual(rebalanceSessions(10, 70, 21), [10, 31]);
    assert.deepEqual(rebalanceSessions(10, 52, 21), [10, 31]);
    assert.deepEqual(rebalanceSessions(10, 51, 21), [10]);
  });

  it('is empty when nothing fits', () => {
    assert.deepEqual(rebalanceSessions(10, 20, 21), []);
  });
});

describe('ranking', () => {
  const pool: Candidate[] = [
    { symbol: 'B', scorePct: 10, returnPct: 1 },
    { symbol: 'A', scorePct: 10, returnPct: 2 },
    { symbol: 'C', scorePct: 30, returnPct: 3 },
    { symbol: 'D', scorePct: -5, returnPct: 4 },
  ];

  it('takes the best scores first and breaks ties by symbol', () => {
    assert.deepEqual(topCandidates(pool, 3).map(c => c.symbol), ['C', 'A', 'B']);
  });

  it('takes the worst scores for the bottom', () => {
    assert.deepEqual(bottomCandidates(pool, 2).map(c => c.symbol), ['B', 'D']);
  });

  it('returns nothing for a non-positive count and everything when asking for more than exists', () => {
    assert.deepEqual(topCandidates(pool, 0), []);
    assert.deepEqual(bottomCandidates(pool, 0), []);
    assert.equal(topCandidates(pool, 99).length, 4);
    assert.equal(bottomCandidates(pool, 99).length, 4);
  });

  it('does not mutate its input', () => {
    const before = pool.map(c => c.symbol);
    topCandidates(pool, 2);
    bottomCandidates(pool, 2);
    assert.deepEqual(pool.map(c => c.symbol), before);
  });
});

describe('decileSize and meanReturnPct', () => {
  it('is a tenth of the pool with a floor of one', () => {
    assert.equal(decileSize(250), 25);
    assert.equal(decileSize(105), 10);
    assert.equal(decileSize(3), 1);
  });

  it('averages equal-weight and is null when empty', () => {
    assert.equal(meanReturnPct([]), null);
    assert.equal(
      meanReturnPct([
        { symbol: 'A', scorePct: 0, returnPct: 4 },
        { symbol: 'B', scorePct: 0, returnPct: -2 },
      ]),
      1,
    );
  });
});

describe('compoundedReturnPct', () => {
  it('chains period returns', () => {
    assert.ok(Math.abs(compoundedReturnPct([10, 10]) - 21) < 1e-9);
    assert.ok(Math.abs(compoundedReturnPct([50, -50]) - -25) < 1e-9);
  });

  it('is zero without periods', () => {
    assert.equal(compoundedReturnPct([]), 0);
  });
});
