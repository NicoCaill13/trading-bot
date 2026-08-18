import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeOneMinuteRvol,
  evaluateOpeningDrive,
  type OpeningDriveContext,
  type OpeningDriveOptions,
} from '../src/openingDrive';
import type { BarData } from '../src/types';
import { assertRatio } from './helpers/assertions';

const OPTS: OpeningDriveOptions = {
  windowStartMinutes: 9 * 60 + 45,
  windowEndMinutes: 10 * 60 + 15,
  minRvol1m: 2.0,
  minImbalance: 0.65,
  maxExtensionPct: 0.015,
  rvolBaselineBars: 20,
  hardStopFloorPct: 0.015,
};

const IN_WINDOW = 10 * 60; // 10:00 EST

function bar(close: number, volume: number, low = close * 0.995): BarData {
  return {
    open: close,
    high: close,
    low,
    close,
    volume,
    timestamp: '2026-08-18T14:00:00Z',
  };
}

/** 20 quiet bars then the impulse, so RVOL is impulseVolume / quietVolume. */
function history(impulse: BarData, quietVolume = 1_000): BarData[] {
  return [...Array.from({ length: 20 }, () => bar(100, quietVolume)), impulse];
}

function context(overrides: Partial<OpeningDriveContext> = {}): OpeningDriveContext {
  const impulseBar = overrides.impulseBar ?? bar(100.5, 5_000);
  return {
    symbol: 'WDC',
    barMinutesSinceMidnight: IN_WINDOW,
    isStraightRun: true,
    straightRunScore: 0.9,
    previousClose: 98,
    sessionOpen: 100,
    sessionVwap: 100,
    impulseBar,
    oneMinBars: overrides.oneMinBars ?? history(impulseBar),
    imbalance: null,
    ...overrides,
  };
}

describe('computeOneMinuteRvol', () => {
  it('divides the impulse volume by the preceding baseline mean', () => {
    const impulse = bar(100.5, 5_000);
    assert.equal(computeOneMinuteRvol(history(impulse), 20), 5);
  });

  it('uses only the last baselineBars sessions', () => {
    const impulse = bar(100.5, 4_000);
    const bars = [bar(100, 100_000), ...Array.from({ length: 3 }, () => bar(100, 1_000)), impulse];
    assert.equal(computeOneMinuteRvol(bars, 3), 4);
  });

  it('returns null without enough history or on a zero baseline', () => {
    assert.equal(computeOneMinuteRvol([bar(100, 1_000)], 20), null);
    assert.equal(computeOneMinuteRvol([bar(100, 0), bar(100, 500)], 1), null);
    assert.equal(computeOneMinuteRvol(history(bar(100, 500)), 0), null);
  });
});

describe('evaluateOpeningDrive — gating', () => {
  it('arms on a volume surge inside the window under the cap', () => {
    const decision = evaluateOpeningDrive(context(), OPTS);

    assert.equal(decision.armed, true);
    assert.equal(decision.rejection, null);
    assert.equal(decision.rvol1m, 5);
    assert.ok(decision.extensionPct !== null && decision.extensionPct < OPTS.maxExtensionPct);
    assert.ok(decision.score > 0);
  });

  it('never arms on a symbol without the straight-run tag', () => {
    const decision = evaluateOpeningDrive(context({ isStraightRun: false }), OPTS);
    assert.equal(decision.rejection, 'not_straight_run');
  });

  it('stays out before 09:45 so it cannot contend with the ORB', () => {
    const decision = evaluateOpeningDrive(
      context({ barMinutesSinceMidnight: 9 * 60 + 44 }),
      OPTS,
    );
    assert.equal(decision.rejection, 'outside_window');
  });

  it('stays out after the window closes', () => {
    const decision = evaluateOpeningDrive(
      context({ barMinutesSinceMidnight: 10 * 60 + 16 }),
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

  it('withholds a decision without a VWAP to measure extension against', () => {
    const decision = evaluateOpeningDrive(context({ sessionVwap: null }), OPTS);
    assert.equal(decision.rejection, 'insufficient_data');
  });

  it('treats a gap down as a stale tag', () => {
    const decision = evaluateOpeningDrive(
      context({ sessionOpen: 97, previousClose: 98 }),
      OPTS,
    );
    assert.equal(decision.rejection, 'gap_down');
  });

  it('tolerates a missing previous close rather than blocking', () => {
    const decision = evaluateOpeningDrive(context({ previousClose: null }), OPTS);
    assert.equal(decision.armed, true);
  });
});

describe('evaluateOpeningDrive — holding the open', () => {
  it('rejects a price below both the open and VWAP', () => {
    const impulseBar = bar(99, 5_000);
    const decision = evaluateOpeningDrive(
      context({ impulseBar, oneMinBars: history(impulseBar), sessionVwap: 100.1 }),
      OPTS,
    );
    assert.equal(decision.rejection, 'open_broken');
  });

  it('accepts a price under VWAP but above the open', () => {
    const impulseBar = bar(100.5, 5_000);
    const decision = evaluateOpeningDrive(
      context({ impulseBar, oneMinBars: history(impulseBar), sessionVwap: 101 }),
      OPTS,
    );

    assert.equal(decision.armed, true);
    assert.ok(decision.extensionPct !== null && decision.extensionPct < 0);
  });

  it('accepts a price under the open but above VWAP', () => {
    const impulseBar = bar(99.5, 5_000);
    const decision = evaluateOpeningDrive(
      context({ impulseBar, oneMinBars: history(impulseBar), sessionVwap: 99 }),
      OPTS,
    );
    assert.equal(decision.armed, true);
  });
});

describe('evaluateOpeningDrive — momentum', () => {
  it('rejects when neither volume nor book pressure confirms', () => {
    const impulseBar = bar(100.5, 1_500);
    const decision = evaluateOpeningDrive(
      context({ impulseBar, oneMinBars: history(impulseBar) }),
      OPTS,
    );

    assert.equal(decision.rejection, 'no_momentum');
    assert.equal(decision.rvol1m, 1.5);
  });

  it('arms on book pressure alone when RVOL is short', () => {
    const impulseBar = bar(100.5, 1_500);
    const decision = evaluateOpeningDrive(
      context({ impulseBar, oneMinBars: history(impulseBar), imbalance: 0.8 }),
      OPTS,
    );

    assert.equal(decision.armed, true);
    assert.equal(decision.imbalance, 0.8);
  });

  it('does not accept book pressure below the threshold', () => {
    const impulseBar = bar(100.5, 1_500);
    const decision = evaluateOpeningDrive(
      context({ impulseBar, oneMinBars: history(impulseBar), imbalance: 0.6 }),
      OPTS,
    );
    assert.equal(decision.rejection, 'no_momentum');
  });
});

describe('evaluateOpeningDrive — anti-chase cap', () => {
  it('rejects a price already beyond the cap above VWAP', () => {
    const impulseBar = bar(102, 5_000);
    const decision = evaluateOpeningDrive(
      context({ impulseBar, oneMinBars: history(impulseBar) }),
      OPTS,
    );

    assert.equal(decision.rejection, 'max_extension');
    assert.equal(decision.extensionPct, 0.02);
  });

  /**
   * The reference is VWAP, not the open: the window starts 15 minutes after the
   * open, so an open-anchored cap would reject every genuine drive on arrival.
   */
  it('stays armed on a drive far above its open but close to VWAP', () => {
    const impulseBar = bar(106, 5_000);
    const decision = evaluateOpeningDrive(
      context({ impulseBar, oneMinBars: history(impulseBar), sessionVwap: 105.5 }),
      OPTS,
    );

    assert.equal(decision.armed, true);
    assert.ok(decision.extensionPct !== null && decision.extensionPct < OPTS.maxExtensionPct);
  });

  /**
   * The shadow-mode audit counts `max_extension` setups to decide whether the cap
   * rejects winners, so the code must only appear once everything else passed.
   */
  it('reports max_extension only when every other condition held', () => {
    const impulseBar = bar(102, 1_000);
    const decision = evaluateOpeningDrive(
      context({ impulseBar, oneMinBars: history(impulseBar) }),
      OPTS,
    );

    assert.equal(decision.rejection, 'no_momentum');
  });

  it('carries the observed metrics and stop on a capped setup', () => {
    const impulseBar = bar(102, 5_000);
    const decision = evaluateOpeningDrive(
      context({ impulseBar, oneMinBars: history(impulseBar) }),
      OPTS,
    );

    assert.equal(decision.rejection, 'max_extension');
    assert.equal(decision.rvol1m, 5);
    assert.ok(decision.stopPrice !== null && decision.stopPrice < impulseBar.close);
    assert.equal(decision.score, 0);
  });

  it('accepts a setup exactly at the cap', () => {
    const impulseBar = bar(101.5, 5_000);
    const decision = evaluateOpeningDrive(
      context({ impulseBar, oneMinBars: history(impulseBar) }),
      OPTS,
    );
    assert.equal(decision.armed, true);
  });
});

describe('evaluateOpeningDrive — stop reference', () => {
  it('rejects a bar with no upward body — there is no impulse to trade', () => {
    const impulseBar = bar(100.5, 5_000, 100.5);
    const decision = evaluateOpeningDrive(
      context({ impulseBar, oneMinBars: history(impulseBar) }),
      OPTS,
    );
    assert.equal(decision.rejection, 'no_impulse_body');
  });

  it('keeps a structural stop that is already wider than the floor', () => {
    const impulseBar = bar(100.5, 5_000, 97);
    const decision = evaluateOpeningDrive(
      context({ impulseBar, oneMinBars: history(impulseBar) }),
      OPTS,
    );

    assert.equal(decision.armed, true);
    assert.equal(decision.stopPrice, 97);
  });

  /**
   * Impulse-bar lows are routinely a few basis points away. Without the floor the
   * risk budget would be divided by a near-zero distance, and a shadow verdict
   * measured against that low would report stop-outs live would never take.
   */
  it('widens a stop tighter than the floor down to the floor', () => {
    const impulseBar = bar(100.5, 5_000, 100.48);
    const decision = evaluateOpeningDrive(
      context({ impulseBar, oneMinBars: history(impulseBar) }),
      OPTS,
    );

    assert.equal(decision.armed, true);
    assertRatio(decision.stopPrice ?? 0, 100.5 * (1 - OPTS.hardStopFloorPct));
  });
});

describe('evaluateOpeningDrive — score', () => {
  it('ranks a stronger volume surge higher', () => {
    const weakBar = bar(100.5, 3_000);
    const strongBar = bar(100.5, 8_000);

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

  it('ranks a better daily run higher at equal volume', () => {
    const good = evaluateOpeningDrive(context({ straightRunScore: 0.9 }), OPTS);
    const poor = evaluateOpeningDrive(context({ straightRunScore: 0.3 }), OPTS);

    assert.ok(good.score > poor.score);
  });
});
