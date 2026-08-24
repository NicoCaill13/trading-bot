import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addSignedVolume,
  computeTapeDelta,
  emptyTapeBucket,
  minuteEpoch,
  signPrint,
} from '../src/tapeDelta';

describe('signPrint — Lee-Ready', () => {
  it('labels a print above the mid as a buy', () => {
    assert.equal(signPrint(10.02, 10.00, 10.00), 1);
  });

  it('labels a print below the mid as a sell', () => {
    assert.equal(signPrint(9.98, 10.00, 10.00), -1);
  });

  it('falls back to the tick test when the print is at the mid', () => {
    assert.equal(signPrint(10.00, 10.00, 9.99), 1);
    assert.equal(signPrint(10.00, 10.00, 10.01), -1);
  });

  it('uses the tick test when no mid is available', () => {
    assert.equal(signPrint(5.10, null, 5.00), 1);
    assert.equal(signPrint(4.90, null, 5.00), -1);
  });

  it('returns 0 when the print cannot be classified', () => {
    assert.equal(signPrint(10, null, null), 0);
    assert.equal(signPrint(10, 10, 10), 0);
    assert.equal(signPrint(0, 10, 9), 0);
  });
});

describe('computeTapeDelta', () => {
  it('is positive when buy volume dominates', () => {
    assert.equal(computeTapeDelta(80, 20), 0.6);
  });

  it('is negative when sell volume dominates', () => {
    assert.equal(computeTapeDelta(10, 90), -0.8);
  });

  it('returns null without classified volume', () => {
    assert.equal(computeTapeDelta(0, 0), null);
  });
});

describe('addSignedVolume', () => {
  it('ignores unclassified and empty prints', () => {
    const start = emptyTapeBucket();
    assert.deepEqual(addSignedVolume(start, 0, 100), start);
    assert.deepEqual(addSignedVolume(start, 1, 0), start);
  });

  it('accumulates buy and sell size', () => {
    const bought = addSignedVolume(emptyTapeBucket(), 1, 200);
    const both = addSignedVolume(bought, -1, 50);
    assert.deepEqual(both, { buyVolume: 200, sellVolume: 50 });
  });
});

describe('minuteEpoch', () => {
  it('floors to the UTC minute', () => {
    assert.equal(
      minuteEpoch('2026-08-18T13:32:45.123Z'),
      minuteEpoch('2026-08-18T13:32:00.000Z'),
    );
  });

  it('returns null on garbage', () => {
    assert.equal(minuteEpoch('not-a-date'), null);
  });
});
