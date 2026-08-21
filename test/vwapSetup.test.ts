import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasImpulseExtension,
  hasVolumeDryUp,
  isGreenBarWithRvol,
  isNearVwap,
  isVwapLagger,
  isVwapPullbackEntryWindow,
  minutesSinceMidnight,
  shouldHardBanSpyBearish,
  volumesFromBars,
} from '../src/vwapSetup';
import type { BarData } from '../src/types';

const WINDOW = {
  startHour: 10,
  startMinute: 0,
  endHour: 11,
  endMinute: 30,
};

function estAt(hour: number, minute: number): Date {
  const d = new Date(2026, 0, 5, hour, minute, 0, 0);
  return d;
}

describe('isVwapPullbackEntryWindow', () => {
  it('rejects 09:59', () => {
    assert.equal(isVwapPullbackEntryWindow(estAt(9, 59), WINDOW), false);
  });

  it('accepts 10:00', () => {
    assert.equal(isVwapPullbackEntryWindow(estAt(10, 0), WINDOW), true);
  });

  it('accepts 11:29', () => {
    assert.equal(isVwapPullbackEntryWindow(estAt(11, 29), WINDOW), true);
  });

  it('rejects 11:30', () => {
    assert.equal(isVwapPullbackEntryWindow(estAt(11, 30), WINDOW), false);
  });

  it('minutesSinceMidnight matches hour*60+minute', () => {
    assert.equal(minutesSinceMidnight(estAt(11, 30)), 11 * 60 + 30);
  });
});

describe('hasImpulseExtension', () => {
  it('rejects a VWAP hug (TWLO 20/08: high 0.19% above VWAP)', () => {
    assert.equal(hasImpulseExtension(220.28, 219.86, 0.005), false);
  });

  it('accepts at the 0.5% boundary', () => {
    assert.equal(hasImpulseExtension(100.5, 100, 0.005), true);
  });

  it('accepts a real thrust then measured vs current VWAP', () => {
    assert.equal(hasImpulseExtension(116.5, 115.15, 0.005), true);
  });

  it('rejects non-positive vwap', () => {
    assert.equal(hasImpulseExtension(101, 0, 0.005), false);
  });
});

describe('isVwapLagger', () => {
  it('flags DOCN 20/08 (gap -1.2%, alpha -15%)', () => {
    assert.equal(isVwapLagger(-0.0119, -0.1531, -0.10), true);
  });

  it('does not flag TWLO (gap up, positive alpha)', () => {
    assert.equal(isVwapLagger(0.0024, 0.1568, -0.10), false);
  });

  it('does not flag a gap-down name that only mildly lagged', () => {
    assert.equal(isVwapLagger(-0.06, -0.029, -0.10), false);
  });

  it('fails open when screener fields are missing', () => {
    assert.equal(isVwapLagger(null, -0.20, -0.10), false);
    assert.equal(isVwapLagger(-0.02, undefined, -0.10), false);
  });
});

describe('isNearVwap', () => {
  it('accepts exact VWAP', () => {
    assert.equal(isNearVwap(100, 100, 0.001), true);
  });

  it('accepts at 0.1% boundary', () => {
    assert.equal(isNearVwap(100.1, 100, 0.001), true);
    assert.equal(isNearVwap(99.9, 100, 0.001), true);
  });

  it('rejects beyond 0.1%', () => {
    assert.equal(isNearVwap(100.11, 100, 0.001), false);
  });

  it('rejects non-positive vwap', () => {
    assert.equal(isNearVwap(100, 0, 0.001), false);
  });
});

describe('hasVolumeDryUp', () => {
  it('passes when pullback avg < 70% of impulse avg', () => {
    assert.equal(hasVolumeDryUp([60, 60], [100, 100], 0.7), true);
  });

  it('fails at equality (must be strictly below ratio)', () => {
    assert.equal(hasVolumeDryUp([70], [100], 0.7), false);
  });

  it('fails with empty series', () => {
    assert.equal(hasVolumeDryUp([], [100], 0.7), false);
    assert.equal(hasVolumeDryUp([50], [], 0.7), false);
  });
});

describe('isGreenBarWithRvol', () => {
  it('requires close > open and rvol > min', () => {
    assert.equal(isGreenBarWithRvol({ open: 10, close: 11 }, 1.51, 1.5), true);
  });

  it('rejects rvol at boundary (strict >)', () => {
    assert.equal(isGreenBarWithRvol({ open: 10, close: 11 }, 1.5, 1.5), false);
  });

  it('rejects red bar', () => {
    assert.equal(isGreenBarWithRvol({ open: 11, close: 10 }, 2, 1.5), false);
  });

  it('rejects null rvol', () => {
    assert.equal(isGreenBarWithRvol({ open: 10, close: 11 }, null, 1.5), false);
  });
});

describe('shouldHardBanSpyBearish', () => {
  it('bans only bearish', () => {
    assert.equal(shouldHardBanSpyBearish('bearish'), true);
    assert.equal(shouldHardBanSpyBearish('bullish'), false);
    assert.equal(shouldHardBanSpyBearish('neutral'), false);
    assert.equal(shouldHardBanSpyBearish('unknown'), false);
  });
});

describe('volumesFromBars', () => {
  it('takes last N volumes', () => {
    const bars: BarData[] = [
      { open: 1, high: 1, low: 1, close: 1, volume: 10, timestamp: 'a' },
      { open: 1, high: 1, low: 1, close: 1, volume: 20, timestamp: 'b' },
      { open: 1, high: 1, low: 1, close: 1, volume: 30, timestamp: 'c' },
    ];
    assert.deepEqual(volumesFromBars(bars, 2), [20, 30]);
  });
});
