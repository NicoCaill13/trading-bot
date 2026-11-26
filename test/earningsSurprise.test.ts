import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSue,
  excessVsWeekBaseline,
  isoWeekOf,
  parseQuarterlyEps,
  reactionSessionIndex,
  type EpsFact,
  type QuarterEps,
} from '../scripts/lib/earningsSurprise';

const QUARTER_ENDS = ['03-31', '06-30', '09-30'] as const;

/** Q1-Q3 only, as a 10-Q-only series is: one array of three EPS values per year. */
function seriesOf(byYear: Record<number, readonly number[]>, current: QuarterEps): QuarterEps[] {
  const series: QuarterEps[] = [];
  for (const year of Object.keys(byYear).map(Number).sort()) {
    byYear[year].forEach((eps, k) => {
      const end = `${year}-${QUARTER_ENDS[k]}`;
      series.push({ end, filed: end, eps });
    });
  }
  series.push(current);
  return series;
}

const GROWTH: Record<number, readonly number[]> = {
  2022: [1.0, 1.0, 1.0],
  2023: [1.1, 1.0, 1.2],
  2024: [1.2, 1.2, 1.1],
  2025: [1.3, 1.1, 1.4],
};

describe('parseQuarterlyEps', () => {
  const fact = (over: Partial<EpsFact>): EpsFact => ({
    start: '2025-04-01',
    end: '2025-06-30',
    val: 1,
    filed: '2025-08-05',
    form: '10-Q',
    ...over,
  });

  it('keeps three-month 10-Q facts only', () => {
    const facts = [
      fact({}),
      fact({ start: '2025-01-01', val: 9 }),
      fact({ form: '10-K', start: '2025-01-01', end: '2025-12-31', val: 8 }),
    ];
    assert.deepEqual(parseQuarterlyEps(facts), [{ end: '2025-06-30', filed: '2025-08-05', eps: 1 }]);
  });

  it('keeps the first filing of a period, not a later restatement', () => {
    const facts = [fact({ filed: '2026-08-04', val: 1.1 }), fact({ filed: '2025-08-05', val: 1 })];
    assert.equal(parseQuarterlyEps(facts)[0].eps, 1);
  });

  it('sorts ascending by period end', () => {
    const facts = [
      fact({ start: '2025-07-01', end: '2025-09-30', filed: '2025-11-04' }),
      fact({}),
    ];
    assert.deepEqual(parseQuarterlyEps(facts).map(q => q.end), ['2025-06-30', '2025-09-30']);
  });
});

describe('computeSue', () => {
  it('divides the year-over-year change by the spread of earlier changes', () => {
    const series = seriesOf(GROWTH, { end: '2026-03-31', filed: '2026-05-05', eps: 2.0 });
    const reading = computeSue(series, series.length - 1);
    assert.ok(reading);

    const prior = [0.1, 0.0, 0.2, 0.1, 0.2, -0.1, 0.1, -0.1, 0.3];
    const mean = prior.reduce((s, v) => s + v, 0) / prior.length;
    const sigma = Math.sqrt(prior.reduce((s, v) => s + (v - mean) ** 2, 0) / (prior.length - 1));
    assert.equal(reading.priorDeltaCount, prior.length);
    assert.ok(Math.abs(reading.delta - 0.7) < 1e-9);
    assert.ok(Math.abs(reading.sigma - sigma) < 1e-9);
    assert.ok(Math.abs(reading.sue - 0.7 / sigma) < 1e-9);
  });

  it('matches the year-ago quarter across a 52-week calendar shift', () => {
    const series = seriesOf(GROWTH, { end: '2026-04-05', filed: '2026-05-05', eps: 2.0 });
    const reading = computeSue(series, series.length - 1);
    assert.ok(reading);
    assert.ok(Math.abs(reading.delta - 0.7) < 1e-9);
  });

  it('returns null with fewer than six earlier changes', () => {
    const series = seriesOf(
      { 2024: GROWTH[2024], 2025: GROWTH[2025] },
      { end: '2026-03-31', filed: '2026-05-05', eps: 2.0 },
    );
    assert.equal(computeSue(series, series.length - 1), null);
  });

  it('returns null when the history has no dispersion', () => {
    const flat = { 2022: [1, 1, 1], 2023: [2, 2, 2], 2024: [3, 3, 3], 2025: [4, 4, 4] };
    const series = seriesOf(flat, { end: '2026-03-31', filed: '2026-05-05', eps: 5 });
    assert.equal(computeSue(series, series.length - 1), null);
  });

  it('returns null when the year-ago quarter is missing', () => {
    const series: QuarterEps[] = [{ end: '2026-03-31', filed: '2026-05-05', eps: 2 }];
    assert.equal(computeSue(series, 0), null);
  });
});

describe('reactionSessionIndex', () => {
  const sessions = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-10'];

  it('reacts the same day when released before the close', () => {
    assert.equal(reactionSessionIndex(sessions, '2026-08-04', 7 * 60 + 30), 1);
  });

  it('reacts the next session when released at or after the close', () => {
    assert.equal(reactionSessionIndex(sessions, '2026-08-04', 16 * 60 + 5), 2);
    assert.equal(reactionSessionIndex(sessions, '2026-08-04', 16 * 60), 2);
  });

  it('rolls a weekend release to Monday', () => {
    assert.equal(reactionSessionIndex(sessions, '2026-08-08', 10 * 60), 5);
  });

  it('returns null past the end of the calendar', () => {
    assert.equal(reactionSessionIndex(sessions, '2026-08-10', 17 * 60), null);
  });
});

describe('isoWeekOf', () => {
  it('numbers ordinary weeks', () => {
    assert.equal(isoWeekOf('2026-08-04'), '2026-W32');
  });

  it('assigns early-January days to the right ISO year', () => {
    assert.equal(isoWeekOf('2026-01-01'), '2026-W01');
    assert.equal(isoWeekOf('2025-12-29'), '2026-W01');
    assert.equal(isoWeekOf('2024-12-30'), '2025-W01');
    assert.equal(isoWeekOf('2021-01-03'), '2020-W53');
  });
});

describe('excessVsWeekBaseline', () => {
  it('subtracts the mean of the same week non-selected events', () => {
    const { samples, droppedNoBaseline } = excessVsWeekBaseline(
      [
        { symbol: 'A', session: '2026-08-04', sue: 3, returnPct: 6 },
        { symbol: 'B', session: '2026-08-05', sue: 0.5, returnPct: 2 },
        { symbol: 'C', session: '2026-08-06', sue: -1, returnPct: 4 },
      ],
      2,
    );
    assert.deepEqual(samples, [{ symbol: 'A', session: '2026-08-04', excessPct: 3 }]);
    assert.equal(droppedNoBaseline, 0);
  });

  it('drops a selected event with no baseline in its week', () => {
    const { samples, droppedNoBaseline } = excessVsWeekBaseline(
      [
        { symbol: 'B', session: '2026-08-05', sue: 0.5, returnPct: 2 },
        { symbol: 'D', session: '2026-08-12', sue: 2.5, returnPct: 5 },
      ],
      2,
    );
    assert.deepEqual(samples, []);
    assert.equal(droppedNoBaseline, 1);
  });

  it('treats SUE equal to the threshold as selected', () => {
    const { samples } = excessVsWeekBaseline(
      [
        { symbol: 'E', session: '2026-08-04', sue: 2, returnPct: 5 },
        { symbol: 'F', session: '2026-08-05', sue: 1, returnPct: 1 },
      ],
      2,
    );
    assert.equal(samples.length, 1);
    assert.equal(samples[0].excessPct, 4);
  });
});
