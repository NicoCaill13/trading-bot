import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cikForSymbol,
  parseEpsFacts,
  parseFilings,
  parseTickerMap,
  type Filing,
} from '../scripts/lib/edgarParse';
import { findEarningsRelease, newYorkMoment, timeRelease } from '../scripts/lib/earningsEvents';
import {
  MAX_MDE_PCT,
  addToRunningStats,
  decideVerdict,
  emptyRunningStats,
  minimumDetectableEffectPct,
  sampleStdDev,
  type VerdictInput,
} from '../scripts/lib/earningsVerdict';
import type { TradeStats } from '../scripts/lib/eligibleStudy';
import type { QuarterEps } from '../scripts/lib/earningsSurprise';

describe('edgarParse', () => {
  it('maps tickers to padded CIKs and resolves share-class dots', () => {
    const map = parseTickerMap({
      '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple' },
      '1': { cik_str: 1067983, ticker: 'BRK-B', title: 'Berkshire' },
      '2': { cik_str: 'bad', ticker: 'XXXX' },
    });
    assert.equal(cikForSymbol(map, 'aapl'), '0000320193');
    assert.equal(cikForSymbol(map, 'BRK.B'), '0001067983');
    assert.equal(cikForSymbol(map, 'XXXX'), null);
  });

  it('keeps well-formed EPS facts only', () => {
    const facts = parseEpsFacts({
      units: {
        'USD/shares': [
          { start: '2025-04-01', end: '2025-06-30', val: 1.2, filed: '2025-08-05', form: '10-Q' },
          { start: '2025-04-01', end: '2025-06-30', val: '1.2', filed: '2025-08-05', form: '10-Q' },
          'noise',
        ],
      },
    });
    assert.deepEqual(facts, [
      { start: '2025-04-01', end: '2025-06-30', val: 1.2, filed: '2025-08-05', form: '10-Q' },
    ]);
    assert.deepEqual(parseEpsFacts(null), []);
    assert.deepEqual(parseEpsFacts({ units: {} }), []);
  });

  it('flattens the parallel arrays of a submissions payload', () => {
    const filings = parseFilings({
      filings: {
        recent: {
          form: ['8-K', '10-Q', '4'],
          filingDate: ['2026-08-04', '2026-08-06', '2026-08-07'],
          acceptanceDateTime: ['2026-08-04T20:05:00.000Z', '2026-08-06T12:00:00.000Z'],
          items: ['2.02,9.01', ''],
        },
      },
    });
    assert.deepEqual(filings, [
      { form: '8-K', filed: '2026-08-04', acceptedAt: '2026-08-04T20:05:00.000Z', items: '2.02,9.01' },
      { form: '10-Q', filed: '2026-08-06', acceptedAt: '2026-08-06T12:00:00.000Z', items: '' },
    ]);
    assert.deepEqual(parseFilings({}), []);
  });
});

describe('earningsEvents', () => {
  const quarter: QuarterEps = { end: '2026-06-30', filed: '2026-08-06', eps: 1 };
  const sessions = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-10'];
  const filing = (over: Partial<Filing>): Filing => ({
    form: '8-K',
    filed: '2026-08-04',
    acceptedAt: '2026-08-04T20:05:00.000Z',
    items: '2.02,9.01',
    ...over,
  });

  it('converts an instant to New York time across DST and midnight', () => {
    assert.deepEqual(newYorkMoment('2026-08-04T20:05:00.000Z'), { date: '2026-08-04', minutes: 965 });
    assert.deepEqual(newYorkMoment('2026-01-13T13:30:00.000Z'), { date: '2026-01-13', minutes: 510 });
    assert.deepEqual(newYorkMoment('2026-08-05T02:00:00.000Z'), { date: '2026-08-04', minutes: 1320 });
    assert.equal(newYorkMoment('not a date'), null);
  });

  it('picks the earliest results release inside the quarter window', () => {
    const picked = findEarningsRelease(quarter, [
      filing({}),
      filing({ filed: '2026-08-03', acceptedAt: '2026-08-03T11:00:00.000Z', items: '2.02' }),
      filing({ items: '5.02' }),
      filing({ form: '10-Q' }),
      filing({ filed: '2026-05-05', acceptedAt: '2026-05-05T20:00:00.000Z' }),
      filing({ filed: '2026-08-07', acceptedAt: '2026-08-07T20:00:00.000Z' }),
    ]);
    assert.equal(picked?.filed, '2026-08-03');
  });

  it('returns null when no release is datable', () => {
    assert.equal(findEarningsRelease(quarter, [filing({ items: '5.02' })]), null);
  });

  it('maps an after-close release to the next session and measures the 10-Q delay', () => {
    const timing = timeRelease(sessions, filing({}), quarter);
    assert.deepEqual(timing, { reactionIndex: 2, gapSessions: 2 });
  });

  it('maps a pre-market release to its own session', () => {
    const timing = timeRelease(
      sessions,
      filing({ acceptedAt: '2026-08-04T12:00:00.000Z' }),
      { ...quarter, filed: '2026-08-05' },
    );
    assert.deepEqual(timing, { reactionIndex: 1, gapSessions: 1 });
  });

  it('returns null for a release before the calendar or a 10-Q after it', () => {
    assert.equal(timeRelease(sessions, filing({ acceptedAt: '2026-07-30T12:00:00.000Z' }), quarter), null);
    assert.equal(timeRelease(sessions, filing({}), { ...quarter, filed: '2026-08-12' }), null);
  });
});

describe('earningsVerdict', () => {
  it('computes a sample standard deviation in one pass', () => {
    const stats = emptyRunningStats();
    [1, 2, 3, 4].forEach(v => addToRunningStats(stats, v));
    assert.ok(Math.abs(sampleStdDev(stats) - Math.sqrt(5 / 3)) < 1e-12);
    assert.equal(sampleStdDev(emptyRunningStats()), 0);
  });

  it('scales the detectable effect with 1 / sqrt(n)', () => {
    assert.ok(Math.abs(minimumDetectableEffectPct(10, 100) - 1.96) < 1e-12);
    assert.equal(minimumDetectableEffectPct(10, 0), Number.POSITIVE_INFINITY);
  });

  const stats = (n: number, low: number): TradeStats => ({
    n,
    days: n,
    distinctSymbols: n,
    targetRate: 0,
    stopRate: 0,
    meanNetPct: low + 1,
    ci95LowPct: low,
    ci95HighPct: low + 2,
    clusteredCi95LowPct: low,
    clusteredCi95HighPct: low + 2,
    top3ProfitShare: 0,
  });
  const passing: VerdictInput = {
    mdePct: 1,
    lateShare: 0.3,
    oosAbsolute: stats(150, 0.2),
    oosExcess: stats(150, 0.1),
    seenAbsoluteMeanPct: 0.5,
    seenExcessMeanPct: 0.4,
  };

  it('passes only when every pre-declared condition holds', () => {
    assert.equal(decideVerdict(passing), 'PASS');
  });

  it('is inconclusive when underpowered, before anything else', () => {
    const input = { ...passing, mdePct: MAX_MDE_PCT + 0.01, lateShare: 0.9 };
    assert.equal(decideVerdict(input), 'INCONCLUSIVE_UNDERPOWERED');
  });

  it('is inconclusive when most 10-Qs lag the release by more than one session', () => {
    assert.equal(decideVerdict({ ...passing, lateShare: 0.51 }), 'INCONCLUSIVE_TIMING');
  });

  it('fails with too few events, a CI touching zero, or a seen sign flip', () => {
    assert.equal(decideVerdict({ ...passing, oosAbsolute: stats(99, 0.2) }), 'FAIL');
    assert.equal(decideVerdict({ ...passing, oosAbsolute: stats(150, 0) }), 'FAIL');
    assert.equal(decideVerdict({ ...passing, oosExcess: stats(150, -0.1) }), 'FAIL');
    assert.equal(decideVerdict({ ...passing, seenExcessMeanPct: -0.1 }), 'FAIL');
    assert.equal(decideVerdict({ ...passing, seenAbsoluteMeanPct: null }), 'FAIL');
  });
});
