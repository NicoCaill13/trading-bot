import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBarToShadowRecord,
  createShadowRecord,
  isHorizonElapsed,
  summarizeShadowRecord,
  type ShadowSignalInput,
} from '../src/shadowJournal';
import type { BarData, OpeningDriveDecision, ShadowSignalRecord } from '../src/types';
import { assertRatio } from './helpers/assertions';

const SIGNAL_AT = '2026-08-13T13:51:00Z'; // 09:51 EST

const DECISION: OpeningDriveDecision = {
  armed: true,
  rejection: null,
  extensionPct: 0.0117,
  rvol1m: 4.25,
  imbalance: null,
  spreadPct: null,
  closeLocation: 0.8,
  tapeDelta: 0.4,
  entryPrice: 100,
  stopPrice: 99,
  score: 12_345,
};

function input(overrides: Partial<ShadowSignalInput> = {}): ShadowSignalInput {
  return {
    symbol: 'WDC',
    signalAt: SIGNAL_AT,
    decision: DECISION,
    straightRunScore: 0.9,
    rejectedBy: null,
    horizonMinutes: 60,
    ...overrides,
  };
}

/** Minutes after the signal, so horizon assertions read plainly. */
function bar(high: number, low: number, minutesAfter = 1): BarData {
  const ts = new Date(new Date(SIGNAL_AT).getTime() + minutesAfter * 60_000).toISOString();
  return { open: low, high, low, close: high, volume: 1_000, timestamp: ts };
}

function fold(record: ShadowSignalRecord, bars: BarData[]): ShadowSignalRecord {
  return bars.reduce(applyBarToShadowRecord, record);
}

describe('createShadowRecord', () => {
  it('derives the NY trading day from the signal instant', () => {
    const record = createShadowRecord(input());
    assert.equal(record.tradingDay, '2026-08-13');
  });

  it('starts with flat excursions and no verdict', () => {
    const record = createShadowRecord(input());

    assert.equal(record.mfePct, 0);
    assert.equal(record.maePct, 0);
    assert.equal(record.mfeBarIndex, null);
    assert.equal(record.stopHitBarIndex, null);
    assert.equal(record.stopHit, false);
    assert.equal(record.stopHitBeforeMfe, false);
    assert.equal(record.barsObserved, 0);
    assert.equal(record.closedAt, null);
  });

  it('carries the theoretical entry and stop from the decision', () => {
    const record = createShadowRecord(input());

    assert.equal(record.entryPrice, 100);
    assert.equal(record.stopPrice, 99);
    assert.equal(record.rvol1m, 4.25);
    assert.equal(record.strategy, 'opening_drive');
  });

  it('tags an audited rejection', () => {
    const record = createShadowRecord(input({ rejectedBy: 'max_extension' }));
    assert.equal(record.rejectedBy, 'max_extension');
  });
});

describe('applyBarToShadowRecord — excursions', () => {
  it('measures MFE on bar highs and MAE on bar lows, not closes', () => {
    const record = fold(createShadowRecord(input()), [bar(103, 99.5, 1)]);

    assertRatio(record.mfePct, 0.03);
    assertRatio(record.maePct, -0.005);
    assert.equal(record.barsObserved, 1);
  });

  it('keeps the running extremes across bars', () => {
    const record = fold(createShadowRecord(input()), [
      bar(102, 99.5, 1),
      bar(101, 99.2, 2),
      bar(104, 100.5, 3),
    ]);

    assertRatio(record.mfePct, 0.04);
    assertRatio(record.maePct, -0.008);
    assert.equal(record.mfeBarIndex, 2);
    assert.equal(record.barsObserved, 3);
  });

  it('never reports a negative MFE or a positive MAE', () => {
    const record = fold(createShadowRecord(input()), [bar(99.8, 99.5, 1)]);

    assert.equal(record.mfePct, 0);
    assert.ok(record.maePct < 0);
    assert.equal(record.mfeBarIndex, null);
  });

  it('leaves the record untouched on a degenerate entry price', () => {
    const broken = createShadowRecord(
      input({ decision: { ...DECISION, entryPrice: null } }),
    );
    assert.equal(applyBarToShadowRecord(broken, bar(103, 99, 1)), broken);
  });

  it('does not mutate the record it folds into', () => {
    const record = createShadowRecord(input());
    applyBarToShadowRecord(record, bar(103, 99.5, 1));

    assert.equal(record.barsObserved, 0);
    assert.equal(record.mfePct, 0);
  });
});

describe('applyBarToShadowRecord — stop verdict', () => {
  it('flags a stop touched intrabar even on a bar closing higher', () => {
    const record = fold(createShadowRecord(input()), [bar(101, 98.9, 1)]);

    assert.equal(record.stopHit, true);
    assert.equal(record.stopHitBarIndex, 0);
  });

  it('keeps the first stop touch, not the latest', () => {
    const record = fold(createShadowRecord(input()), [
      bar(101, 98.5, 1),
      bar(100, 98.0, 2),
    ]);
    assert.equal(record.stopHitBarIndex, 0);
  });

  it('reports MFE first when the peak precedes the stop', () => {
    const record = fold(createShadowRecord(input()), [
      bar(104, 100.5, 1),
      bar(100, 98.5, 2),
    ]);

    assert.equal(record.stopHit, true);
    assert.equal(record.stopHitBeforeMfe, false);
    assert.equal(record.mfeBarIndex, 0);
    assert.equal(record.stopHitBarIndex, 1);
  });

  it('reports the stop first when it precedes the peak', () => {
    const record = fold(createShadowRecord(input()), [
      bar(100.5, 98.5, 1),
      bar(105, 100.5, 2),
    ]);

    assert.equal(record.stopHitBeforeMfe, true);
    assert.equal(record.stopHitBarIndex, 0);
    assert.equal(record.mfeBarIndex, 1);
  });

  /**
   * Bar data cannot order a high and a low inside one minute. Counting the stop
   * as first is the pessimistic reading, which keeps the anti-chase audit from
   * arguing for a looser cap on evidence it does not have.
   */
  it('treats a same-bar stop and peak as stop-first', () => {
    const record = fold(createShadowRecord(input()), [bar(105, 98.5, 1)]);

    assert.equal(record.mfeBarIndex, 0);
    assert.equal(record.stopHitBarIndex, 0);
    assert.equal(record.stopHitBeforeMfe, true);
  });

  it('treats a stop with no favorable excursion as stop-first', () => {
    const record = fold(createShadowRecord(input()), [bar(99.9, 98.5, 1)]);

    assert.equal(record.mfeBarIndex, null);
    assert.equal(record.stopHitBeforeMfe, true);
  });

  it('never flags a stop that was not reached', () => {
    const record = fold(createShadowRecord(input()), [
      bar(103, 99.5, 1),
      bar(104, 99.1, 2),
    ]);

    assert.equal(record.stopHit, false);
    assert.equal(record.stopHitBeforeMfe, false);
  });

  it('ignores the stop verdict when no stop reference exists', () => {
    const record = fold(
      createShadowRecord(input({ decision: { ...DECISION, stopPrice: null } })),
      [bar(101, 1, 1)],
    );

    assert.equal(record.stopPrice, 0);
    assert.equal(record.stopHit, false);
  });
});

describe('isHorizonElapsed', () => {
  it('stays open inside the horizon', () => {
    const record = createShadowRecord(input());
    assert.equal(isHorizonElapsed(record, bar(101, 100, 59)), false);
  });

  it('stays open on the horizon boundary', () => {
    const record = createShadowRecord(input());
    assert.equal(isHorizonElapsed(record, bar(101, 100, 60)), false);
  });

  it('elapses past the horizon', () => {
    const record = createShadowRecord(input());
    assert.equal(isHorizonElapsed(record, bar(101, 100, 61)), true);
  });

  it('honours a shortened horizon', () => {
    const record = createShadowRecord(input({ horizonMinutes: 15 }));
    assert.equal(isHorizonElapsed(record, bar(101, 100, 16)), true);
  });

  it('does not elapse on an unparseable timestamp', () => {
    const record = createShadowRecord(input());
    const broken: BarData = { ...bar(101, 100, 61), timestamp: 'not-a-date' };
    assert.equal(isHorizonElapsed(record, broken), false);
  });
});

describe('summarizeShadowRecord', () => {
  it('names the stopped-before-peak verdict', () => {
    const record = fold(createShadowRecord(input()), [bar(99.9, 98.5, 1)]);
    assert.match(summarizeShadowRecord(record), /STOPPED before MFE/);
  });

  it('names the peak-then-stopped verdict', () => {
    const record = fold(createShadowRecord(input()), [
      bar(104, 100.5, 1),
      bar(100, 98.5, 2),
    ]);
    assert.match(summarizeShadowRecord(record), /MFE then stopped/);
  });

  it('names the untouched verdict and the audited gate', () => {
    const record = fold(
      createShadowRecord(input({ rejectedBy: 'max_extension' })),
      [bar(103, 99.5, 1)],
    );

    const summary = summarizeShadowRecord(record);
    assert.match(summary, /never stopped/);
    assert.match(summary, /max_extension/);
  });
});
