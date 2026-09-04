import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCloseLocation,
  computeOneMinuteRvol,
  computeOpeningDriveScore,
  computeOrbVolumeMultiple,
  computeSpreadPct,
  evaluateOpeningDrive,
  isChasingOpeningRangeHigh,
  isOpeningDriveFunnelRejection,
  SCANNER_HOLD_GATES,
  type OpeningDriveContext,
  type OpeningDriveOptions,
} from '../src/openingDrive';
import type { BarData } from '../src/types';
import { assertRatio } from './helpers/assertions';

const OPTS: OpeningDriveOptions = {
  windowStartMinutes: 9 * 60 + 30,
  windowEndMinutes: 9 * 60 + 45,
  minRvol1m: 2.0,
  maxExtensionPct: 0.08,
  rvolBaselineBars: 20,
  minOrbVolumeMultiple: 1.5,
  minCloseLocation: 2 / 3,
  maxSpreadPct: 0.004,
  minTapeDelta: 0,
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
    bid: null,
    ask: null,
    tapeDelta: null,
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

  it('does not reject a gap down — the break of the opening range is the setup', () => {
    const decision = evaluateOpeningDrive(
      context({ sessionOpen: 4.40, previousClose: 4.50 }),
      OPTS,
    );
    assert.equal(decision.armed, true);
    assert.equal(decision.rejection, null);
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
  it('rejects when RVOL and ORB volume multiple are both short', () => {
    const impulse = bar(5.20, 90_000, 5.12, 5.22);
    const decision = evaluateOpeningDrive(
      context({ impulseBar: impulse, oneMinBars: history(impulse, 80_000) }),
      OPTS,
    );

    assert.equal(decision.rejection, 'no_momentum');
  });

  it('does not arm on tape or a tight spread when volume is short', () => {
    const impulse = bar(5.20, 90_000, 5.12, 5.22);
    const decision = evaluateOpeningDrive(
      context({
        impulseBar: impulse,
        oneMinBars: history(impulse, 80_000),
        bid: 5.19,
        ask: 5.20,
        tapeDelta: 0.8,
      }),
      OPTS,
    );

    assert.equal(decision.armed, false);
    assert.equal(decision.rejection, 'no_momentum');
  });

  it('arms on volume when quotes and tape are missing', () => {
    const decision = evaluateOpeningDrive(context(), OPTS);
    assert.equal(decision.armed, true);
    assert.equal(decision.spreadPct, null);
    assert.equal(decision.tapeDelta, null);
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

describe('evaluateOpeningDrive — close location', () => {
  it('places the close in the bar range', () => {
    assertRatio(computeCloseLocation(bar(5.20, 1, 5.12, 5.22)) ?? 0, 0.8);
  });

  it('rejects a close in the lower half of the impulse bar', () => {
    const impulse = bar(5.14, 200_000, 5.12, 5.22);
    const decision = evaluateOpeningDrive(
      context({ impulseBar: impulse, oneMinBars: history(impulse) }),
      OPTS,
    );
    assert.equal(decision.rejection, 'no_impulse_body');
  });
});

describe('evaluateOpeningDrive — spread veto', () => {
  it('returns null without a two-sided quote', () => {
    assert.equal(computeSpreadPct(null, 5.2), null);
    assert.equal(computeSpreadPct(5.2, null), null);
  });

  it('fails open when no quote is present', () => {
    const decision = evaluateOpeningDrive(context({ bid: null, ask: null }), OPTS);
    assert.equal(decision.armed, true);
  });

  it('rejects a quote too wide to trade', () => {
    const decision = evaluateOpeningDrive(context({ bid: 5.00, ask: 5.05 }), OPTS);
    assert.equal(decision.rejection, 'wide_spread');
    assert.ok(decision.spreadPct !== null && decision.spreadPct > OPTS.maxSpreadPct);
  });

  it('rejects a crossed market', () => {
    const decision = evaluateOpeningDrive(context({ bid: 5.22, ask: 5.18 }), OPTS);
    assert.equal(decision.rejection, 'wide_spread');
  });

  it('arms when the spread is inside the cap', () => {
    const decision = evaluateOpeningDrive(context({ bid: 5.19, ask: 5.20 }), OPTS);
    assert.equal(decision.armed, true);
  });
});

describe('evaluateOpeningDrive — tape veto', () => {
  it('fails open when no prints were classified', () => {
    const decision = evaluateOpeningDrive(context({ tapeDelta: null }), OPTS);
    assert.equal(decision.armed, true);
  });

  it('rejects selling pressure on the impulse minute', () => {
    const decision = evaluateOpeningDrive(context({ tapeDelta: -0.2 }), OPTS);
    assert.equal(decision.rejection, 'adverse_tape');
  });

  it('rejects a flat tape when the floor is zero', () => {
    const decision = evaluateOpeningDrive(context({ tapeDelta: 0 }), OPTS);
    assert.equal(decision.rejection, 'adverse_tape');
  });

  it('arms when the tape is buying', () => {
    const decision = evaluateOpeningDrive(context({ tapeDelta: 0.3 }), OPTS);
    assert.equal(decision.armed, true);
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
    const impulse = bar(5.20, 200_000, 5.10, 5.22);
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

  it('ranks equal share-volume by dollar flow, not print count', () => {
    const snap = computeOpeningDriveScore({
      impulseVolume: 200_000,
      impulseClose: 5.95,
      edgePct: 0.04,
      volumeConviction: 1,
    });
    const crcl = computeOpeningDriveScore({
      impulseVolume: 200_000,
      impulseClose: 94.69,
      edgePct: 0.04,
      volumeConviction: 1,
    });
    assert.ok(crcl > snap);
    assert.ok(Math.abs(crcl / snap - 94.69 / 5.95) < 1e-9);
  });

  it('ranks equal dollar flow equally, regardless of price', () => {
    const low = computeOpeningDriveScore({
      impulseVolume: 200_000,
      impulseClose: 6,
      edgePct: 0.04,
      volumeConviction: 1,
    });
    const high = computeOpeningDriveScore({
      impulseVolume: 200_000 * (6 / 95),
      impulseClose: 95,
      edgePct: 0.04,
      volumeConviction: 1,
    });
    assert.ok(Math.abs(low - high) < 1e-6);
  });
});

describe('isOpeningDriveFunnelRejection', () => {
  it('hides outside_window — it is not a setup evaluation', () => {
    assert.equal(isOpeningDriveFunnelRejection('outside_window'), false);
    assert.equal(isOpeningDriveFunnelRejection(null), false);
  });

  it('keeps every in-window rejection as a funnel step', () => {
    const codes = [
      'insufficient_data',
      'not_in_scanner',
      'gap_down',
      'orb_not_ready',
      'no_breakout',
      'open_broken',
      'extension_too_low',
      'extension_too_high',
      'chasing_open_high',
      'below_vwap',
      'no_momentum',
      'no_impulse_body',
      'adverse_tape',
      'wide_spread',
      'max_extension',
    ] as const;
    for (const code of codes) {
      assert.equal(isOpeningDriveFunnelRejection(code), true);
    }
  });
});

const HOLD_OPTS: OpeningDriveOptions = {
  ...OPTS,
  windowEndMinutes: 10 * 60,
  ...SCANNER_HOLD_GATES,
  minOpenExtensionPct: 0.025,
  maxOpenExtensionPct: 0.055,
};

/** 09:30 impulse wick: +8% high, later hold sits inside it. */
const HOLD_RANGE = bar(53.50, 200_000, 49.50, 54.00, '2026-08-18T13:30:00Z');

function holdContext(overrides: Partial<OpeningDriveContext> = {}): OpeningDriveContext {
  const impulseBar = overrides.impulseBar ?? bar(52.40, 40_000, 52.00, 52.60);
  return context({
    rangeBar: HOLD_RANGE,
    sessionOpen: 50,
    sessionVwap: 51,
    impulseBar,
    oneMinBars: [
      ...Array.from({ length: 18 }, () => bar(48, 10_000, 47.5, 48.5, '2026-08-18T12:00:00Z')),
      HOLD_RANGE,
      impulseBar,
    ],
    inScanner: true,
    ...overrides,
  });
}

describe('evaluateOpeningDrive — scanner hold (anti-FOMO)', () => {
  it('arms ASAN-like +4.8% after the 09:30 wick, still above the open, not on the high', () => {
    const decision = evaluateOpeningDrive(holdContext(), HOLD_OPTS);
    assert.equal(decision.armed, true);
    assert.equal(decision.rejection, null);
    assert.ok(decision.entryPrice !== null && decision.entryPrice < HOLD_RANGE.high);
    assert.ok(decision.score > 0);
  });

  it('refuses a warmup name that is not in the scanner ranking', () => {
    const decision = evaluateOpeningDrive(holdContext({ inScanner: false }), HOLD_OPTS);
    assert.equal(decision.rejection, 'not_in_scanner');
    assert.equal(decision.armed, false);
  });

  it('rejects AI +1.5% / SNAP loc=1 +1.4% — below the 2.5% open-extension floor', () => {
    const ai = bar(20.30, 200_000, 20.20, 20.32);
    const range = bar(20.00, 80_000, 19.80, 20.25, '2026-08-18T13:30:00Z');
    const aiDecision = evaluateOpeningDrive(
      context({
        rangeBar: range,
        sessionOpen: 20,
        sessionVwap: 20.10,
        impulseBar: ai,
        oneMinBars: history(ai),
        inScanner: true,
      }),
      HOLD_OPTS,
    );
    assert.equal(aiDecision.rejection, 'extension_too_low');

    const snap = bar(10.14, 80_000, 10.00, 10.14);
    const snapRange = bar(10.00, 50_000, 9.90, 10.10, '2026-08-18T13:30:00Z');
    const snapDecision = evaluateOpeningDrive(
      context({
        rangeBar: snapRange,
        sessionOpen: 10,
        sessionVwap: 10.05,
        impulseBar: snap,
        oneMinBars: [snapRange, snap],
        inScanner: true,
      }),
      HOLD_OPTS,
    );
    assert.equal(snapDecision.rejection, 'extension_too_low');
    assert.equal(computeCloseLocation(snap), 1);
  });

  it('rejects BRZE +8.4% / HNGE +7.2% / TNDM +5.8% — wait for a return into 5.5%', () => {
    const cases: Array<{ last: number; open: number }> = [
      { last: 43.36, open: 40 },
      { last: 53.60, open: 50 },
      { last: 52.90, open: 50 },
    ];
    for (const { last, open } of cases) {
      const impulse = bar(last, 40_000, last * 0.995, last * 1.002);
      const decision = evaluateOpeningDrive(
        holdContext({ impulseBar: impulse, sessionOpen: open }),
        HOLD_OPTS,
      );
      assert.equal(decision.rejection, 'extension_too_high', `${last} vs ${open}`);
    }
  });

  it('rejects a close glued to the 09:30 high even when the open-extension is in band', () => {
    const gluedHigh = 52.40;
    const range = bar(52.00, 200_000, 49.50, gluedHigh, '2026-08-18T13:30:00Z');
    const onHigh = bar(gluedHigh, 40_000, 52.00, gluedHigh);
    const decision = evaluateOpeningDrive(
      holdContext({
        rangeBar: range,
        impulseBar: onHigh,
        sessionOpen: 50,
        oneMinBars: [
          ...Array.from({ length: 18 }, () => bar(48, 10_000, 47.5, 48.5, '2026-08-18T12:00:00Z')),
          range,
          onHigh,
        ],
      }),
      HOLD_OPTS,
    );
    assert.equal(isChasingOpeningRangeHigh(gluedHigh, gluedHigh), true);
    assert.equal(decision.rejection, 'chasing_open_high');
  });

  it('rejects a hold that has lost session VWAP', () => {
    const decision = evaluateOpeningDrive(holdContext({ sessionVwap: 52.50 }), HOLD_OPTS);
    assert.equal(decision.rejection, 'below_vwap');
  });

  it('does not require a break of the 09:30 high (that is the FOMO trigger)', () => {
    const decision = evaluateOpeningDrive(holdContext(), HOLD_OPTS);
    assert.ok(decision.entryPrice !== null && decision.entryPrice <= HOLD_RANGE.high);
    assert.equal(decision.armed, true);
  });

  it('rejects CDE 09:33 glued to the impulse high, arms the 09:34 hold (02/09)', () => {
    const range = bar(20.89, 2_981, 20.67, 20.89, '2026-09-02T13:30:00Z');
    const spike = bar(21.42, 5_029, 21.23, 21.42, '2026-09-02T13:33:00Z');
    const hold = bar(21.38, 3_600, 21.34, 21.41, '2026-09-02T13:34:00Z');
    const history = [
      range,
      bar(20.99, 2_199, 20.91, 20.99, '2026-09-02T13:31:00Z'),
      bar(21.12, 4_223, 20.96, 21.12, '2026-09-02T13:32:00Z'),
      spike,
    ];
    const base = {
      rangeBar: range,
      sessionOpen: 20.67,
      sessionVwap: 21.10,
      inScanner: true,
      sessionHigh: 21.42,
    };

    const onSpike = evaluateOpeningDrive(
      context({
        ...base,
        impulseBar: spike,
        oneMinBars: history,
        barMinutesSinceMidnight: 9 * 60 + 33,
      }),
      HOLD_OPTS,
    );
    assert.equal(onSpike.rejection, 'chasing_open_high');

    const pullback = evaluateOpeningDrive(
      context({
        ...base,
        impulseBar: hold,
        oneMinBars: [...history, hold],
        barMinutesSinceMidnight: 9 * 60 + 34,
      }),
      HOLD_OPTS,
    );
    assert.equal(pullback.armed, true);
    assert.ok(pullback.entryPrice !== null && pullback.entryPrice < 21.42);
    assert.ok(pullback.entryPrice !== null && pullback.entryPrice > range.high);
  });

  it('rejects ASTS 09:32 under 2.5%, arms the pullback off the 09:37 wick (02/09)', () => {
    const range = bar(58.83, 5_386, 58.03, 58.88, '2026-09-02T13:30:00Z');
    const early = bar(59.83, 3_894, 59.83, 60.59, '2026-09-02T13:32:00Z');
    const pullback = bar(60.36, 3_847, 59.95, 60.97, '2026-09-02T13:38:00Z');
    const tooEarly = evaluateOpeningDrive(
      context({
        rangeBar: range,
        sessionOpen: 58.52,
        sessionVwap: 59.50,
        impulseBar: early,
        oneMinBars: [range, early],
        inScanner: true,
        sessionHigh: 60.59,
        barMinutesSinceMidnight: 9 * 60 + 32,
      }),
      HOLD_OPTS,
    );
    assert.equal(tooEarly.rejection, 'extension_too_low');

    const hold = evaluateOpeningDrive(
      context({
        rangeBar: range,
        sessionOpen: 58.52,
        sessionVwap: 59.90,
        impulseBar: pullback,
        oneMinBars: [range, pullback],
        inScanner: true,
        sessionHigh: 61.42,
        barMinutesSinceMidnight: 9 * 60 + 38,
      }),
      HOLD_OPTS,
    );
    assert.equal(hold.armed, true);
    assert.ok(hold.entryPrice !== null && hold.entryPrice > range.high);
  });

  it('rejects DKNG 09:34 when the close is the running high (02/09)', () => {
    const range = bar(23.96, 1_208, 23.88, 24.03, '2026-09-02T13:30:00Z');
    const spike = bar(24.75, 5_759, 24.67, 24.75, '2026-09-02T13:34:00Z');
    const decision = evaluateOpeningDrive(
      context({
        rangeBar: range,
        sessionOpen: 24.03,
        sessionVwap: 24.40,
        impulseBar: spike,
        oneMinBars: [range, spike],
        inScanner: true,
        sessionHigh: 24.75,
        barMinutesSinceMidnight: 9 * 60 + 34,
      }),
      HOLD_OPTS,
    );
    assert.equal(decision.rejection, 'chasing_open_high');
  });
});
