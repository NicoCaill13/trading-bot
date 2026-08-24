import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeOneMinuteRvol,
  computeOrbVolumeMultiple,
  evaluateOpeningDrive,
  type OpeningDriveContext,
  type OpeningDriveOptions,
} from '../src/openingDrive';
import type { BarData } from '../src/types';
import { assertRatio } from './helpers/assertions';

const OPTS: OpeningDriveOptions = {
  windowStartMinutes: 9 * 60 + 30,
  windowEndMinutes: 9 * 60 + 45,
  minRvol1m: 2.0,
  minImbalance: 0.65,
  maxExtensionPct: 0.08,
  rvolBaselineBars: 20,
  minOrbVolumeMultiple: 1.5,
  hardStopFloorPct: 0.025,
};

const IN_WINDOW = 9 * 60 + 32;

function bar(
  close: number,
  volume: number,
  low = close * 0.995,
  high = close,
  timestamp = '2026-08-18T13:32:00Z',
): BarData {
  return {
    open: close,
    high,
    low,
    close,
    volume,
    timestamp,
  };
}

const RANGE = bar(5.00, 80_000, 4.90, 5.10, '2026-08-18T13:30:00Z');

/** Quiet premarket + first-minute range + impulse, so RVOL is defined. */
function history(impulse: BarData, quietVolume = 10_000): BarData[] {
  return [
    ...Array.from({ length: 18 }, () => bar(4.80, quietVolume, 4.75, 4.85, '2026-08-18T12:00:00Z')),
    RANGE,
    impulse,
  ];
}

function context(overrides: Partial<OpeningDriveContext> = {}): OpeningDriveContext {
  const impulseBar = overrides.impulseBar ?? bar(5.20, 200_000, 5.12, 5.22);
  return {
    symbol: 'ABCD',
    barMinutesSinceMidnight: IN_WINDOW,
    rangeBar: RANGE,
    previousClose: 4.50,
    sessionOpen: 5.00,
    sessionVwap: 5.05,
    impulseBar,
    oneMinBars: overrides.oneMinBars ?? history(impulseBar),
    imbalance: null,
    ...overrides,
  };
}

describe('computeOneMinuteRvol', () => {
  it('divides the impulse volume by the preceding baseline mean', () => {
    const impulse = bar(5.20, 50_000);
    const bars = [...Array.from({ length: 20 }, () => bar(5.00, 10_000)), impulse];
    assert.equal(computeOneMinuteRvol(bars, 20), 5);
  });

  it('returns null without enough history or on a zero baseline', () => {
    assert.equal(computeOneMinuteRvol([bar(5, 1_000)], 20), null);
    assert.equal(computeOneMinuteRvol([bar(5, 0), bar(5, 500)], 1), null);
    assert.equal(computeOneMinuteRvol(history(bar(5, 500)), 0), null);
  });
});

describe('computeOrbVolumeMultiple', () => {
  it('divides the break bar by the first-minute volume', () => {
    assert.equal(computeOrbVolumeMultiple(150_000, 100_000), 1.5);
  });

  it('returns null on a zero range volume', () => {
    assert.equal(computeOrbVolumeMultiple(100, 0), null);
  });
});

describe('evaluateOpeningDrive — ORB 1-min gating', () => {
  it('arms on a first-minute high break with volume acceleration', () => {
    const decision = evaluateOpeningDrive(context(), OPTS);

    assert.equal(decision.armed, true);
    assert.equal(decision.rejection, null);
    assert.ok(decision.score > 0);
    assert.ok(decision.entryPrice !== null && decision.entryPrice > RANGE.high);
  });

  it('does not require a straight-run tag', () => {
    const decision = evaluateOpeningDrive(context(), OPTS);
    assert.equal(decision.armed, true);
  });

  it('stays out before 09:30', () => {
    const decision = evaluateOpeningDrive(
      context({ barMinutesSinceMidnight: 9 * 60 + 29 }),
      OPTS,
    );
    assert.equal(decision.rejection, 'outside_window');
  });

  it('stays out after 09:45', () => {
    const decision = evaluateOpeningDrive(
      context({ barMinutesSinceMidnight: 9 * 60 + 46 }),
      OPTS,
    );
    assert.equal(decision.rejection, 'outside_window');
  });

  it('accepts both window bounds', () => {
    for (const minutes of [OPTS.windowStartMinutes, OPTS.windowEndMinutes]) {
      const decision = evaluateOpeningDrive(context({ barMinutesSinceMidnight: minutes }), OPTS);
      assert.equal(decision.armed, true, `rejected at ${minutes}`);
    }
  });

  it('withholds a decision until the session open is known', () => {
    const decision = evaluateOpeningDrive(context({ sessionOpen: null }), OPTS);
    assert.equal(decision.rejection, 'insufficient_data');
  });

  it('treats a gap down as a stale runner', () => {
    const decision = evaluateOpeningDrive(
      context({ sessionOpen: 4.40, previousClose: 4.50 }),
      OPTS,
    );
    assert.equal(decision.rejection, 'gap_down');
  });

  it('refuses to arm on the range bar itself', () => {
    const decision = evaluateOpeningDrive(
      context({
        rangeBar: RANGE,
        impulseBar: RANGE,
        oneMinBars: [RANGE],
        barMinutesSinceMidnight: 9 * 60 + 30,
      }),
      OPTS,
    );
    assert.equal(decision.rejection, 'orb_not_ready');
  });

  it('refuses to arm before the first-minute range exists', () => {
    const impulse = bar(5.20, 200_000, 5.12, 5.22);
    const decision = evaluateOpeningDrive(
      context({ rangeBar: null, impulseBar: impulse, oneMinBars: [impulse] }),
      OPTS,
    );
    assert.equal(decision.rejection, 'orb_not_ready');
  });

  it('rejects a close that has not cleared the first-minute high', () => {
    const impulse = bar(5.08, 200_000, 5.00, 5.09);
    const decision = evaluateOpeningDrive(
      context({ impulseBar: impulse, oneMinBars: history(impulse) }),
      OPTS,
    );
    assert.equal(decision.rejection, 'no_breakout');
  });

  it('rejects a break that has already lost the session open', () => {
    const impulse = bar(4.95, 200_000, 4.90, 5.15);
    const decision = evaluateOpeningDrive(
      context({ impulseBar: impulse, oneMinBars: history(impulse), sessionOpen: 5.00 }),
      OPTS,
    );
    assert.equal(decision.rejection, 'open_broken');
  });
});

describe('evaluateOpeningDrive — momentum', () => {
  it('rejects when RVOL, ORB volume multiple and book are all short', () => {
    const impulse = bar(5.20, 90_000, 5.12, 5.22);
    const decision = evaluateOpeningDrive(
      context({ impulseBar: impulse, oneMinBars: history(impulse, 80_000) }),
      OPTS,
    );

    assert.equal(decision.rejection, 'no_momentum');
  });

  it('arms on book pressure alone when volume is short', () => {
    const impulse = bar(5.20, 90_000, 5.12, 5.22);
    const decision = evaluateOpeningDrive(
      context({
        impulseBar: impulse,
        oneMinBars: history(impulse, 80_000),
        imbalance: 0.8,
      }),
      OPTS,
    );

    assert.equal(decision.armed, true);
    assert.equal(decision.imbalance, 0.8);
  });

  it('arms on first-minute volume multiple without RVOL', () => {
    const impulse = bar(5.20, 160_000, 5.12, 5.22);
    const shortHistory: BarData[] = [RANGE, impulse];
    const decision = evaluateOpeningDrive(
      context({ impulseBar: impulse, oneMinBars: shortHistory }),
      OPTS,
    );

    assert.equal(decision.armed, true);
    assert.equal(computeOrbVolumeMultiple(160_000, RANGE.volume), 2);
  });
});

describe('evaluateOpeningDrive — anti-chase cap', () => {
  it('rejects a price already beyond the cap above VWAP', () => {
    const impulse = bar(5.60, 200_000, 5.40, 5.62);
    const decision = evaluateOpeningDrive(
      context({ impulseBar: impulse, oneMinBars: history(impulse), sessionVwap: 5.05 }),
      OPTS,
    );

    assert.equal(decision.rejection, 'max_extension');
    assert.ok(decision.extensionPct !== null && decision.extensionPct > OPTS.maxExtensionPct);
  });

  it('reports max_extension only when every other condition held', () => {
    const impulse = bar(5.60, 20_000, 5.40, 5.62);
    const decision = evaluateOpeningDrive(
      context({ impulseBar: impulse, oneMinBars: history(impulse, 80_000) }),
      OPTS,
    );

    assert.equal(decision.rejection, 'no_momentum');
  });
});

describe('evaluateOpeningDrive — stop reference', () => {
  it('rejects a bar with no upward body', () => {
    const impulse = bar(5.20, 200_000, 5.20, 5.20);
    const decision = evaluateOpeningDrive(
      context({ impulseBar: impulse, oneMinBars: history(impulse) }),
      OPTS,
    );
    assert.equal(decision.rejection, 'no_impulse_body');
  });

  it('uses the first-minute low as the structural stop when it is wider than the floor', () => {
    const wideRange = bar(5.00, 80_000, 4.60, 5.10, '2026-08-18T13:30:00Z');
    const impulse = bar(5.20, 200_000, 5.12, 5.22);
    const decision = evaluateOpeningDrive(
      context({
        rangeBar: wideRange,
        impulseBar: impulse,
        oneMinBars: [
          ...Array.from({ length: 18 }, () => bar(4.80, 10_000)),
          wideRange,
          impulse,
        ],
      }),
      OPTS,
    );

    assert.equal(decision.armed, true);
    assert.equal(decision.stopPrice, 4.60);
  });

  it('widens a tight first-minute low down to the hard floor', () => {
    const tightRange = bar(5.00, 80_000, 5.08, 5.10, '2026-08-18T13:30:00Z');
    const impulse = bar(5.20, 200_000, 5.18, 5.22);
    const decision = evaluateOpeningDrive(
      context({
        rangeBar: tightRange,
        impulseBar: impulse,
        oneMinBars: [
          ...Array.from({ length: 18 }, () => bar(4.80, 10_000)),
          tightRange,
          impulse,
        ],
      }),
      OPTS,
    );

    assert.equal(decision.armed, true);
    assertRatio(decision.stopPrice ?? 0, 5.20 * (1 - OPTS.hardStopFloorPct));
  });
});

describe('evaluateOpeningDrive — score', () => {
  it('ranks a stronger volume surge higher', () => {
    const weakBar = bar(5.20, 160_000, 5.12, 5.22);
    const strongBar = bar(5.20, 400_000, 5.12, 5.22);

    const weak = evaluateOpeningDrive(
      context({ impulseBar: weakBar, oneMinBars: history(weakBar) }),
      OPTS,
    );
    const strong = evaluateOpeningDrive(
      context({ impulseBar: strongBar, oneMinBars: history(strongBar) }),
      OPTS,
    );

    assert.ok(strong.score > weak.score);
  });
});
