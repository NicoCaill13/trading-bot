import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeGapHoldDecision,
  evaluateGapHold,
  type GapHoldContext,
  type GapHoldOptions,
} from '../src/gapHold';
import type { BarData } from '../src/types';

const OPTS: GapHoldOptions = {
  windowStartMinutes: 9 * 60 + 35,
  windowEndMinutes: 10 * 60 + 30,
  minOvernightGapPct: 0.08,
  maxOvernightGapPct: 0.55,
  continuationMaxGapPct: 0.12,
  gapFillTolerancePct: 0.01,
  maxSpreadPct: 0.004,
  hardStopFloorPct: 0.025,
  requireScannerMember: true,
  requireAboveVwap: true,
};

function bar(
  minute: number,
  close: number,
  opts: Partial<BarData> = {},
): BarData {
  const hour = Math.floor(minute / 60);
  const min = minute % 60;
  const timestamp = `2026-09-03T${String(hour + 4).padStart(2, '0')}:${String(min).padStart(2, '0')}:00.000Z`;
  return {
    open: opts.open ?? close,
    high: opts.high ?? close,
    low: opts.low ?? close,
    close,
    volume: opts.volume ?? 50_000,
    timestamp: opts.timestamp ?? timestamp,
  };
}

function ctx(partial: Partial<GapHoldContext> & Pick<GapHoldContext, 'impulseBar'>): GapHoldContext {
  const impulse = partial.impulseBar;
  const range = partial.rangeBar ?? bar(9 * 60 + 30, 12.0, { low: 11.95, high: 12.1 });
  return {
    symbol: 'CHPT',
    barMinutesSinceMidnight: 9 * 60 + 40,
    rangeBar: range,
    previousClose: 9.0,
    previousHigh: 9.4,
    sessionOpen: 12.0,
    sessionVwap: 12.05,
    oneMinBars: [range, impulse],
    bid: 12.18,
    ask: 12.20,
    inScanner: true,
    track: 'news_gap',
    catalystPasses: true,
    ...partial,
    impulseBar: impulse,
  };
}

describe('evaluateGapHold — news gap', () => {
  it('arms a CHPT-style overnight gap that still holds above the open', () => {
    const impulse = bar(9 * 60 + 40, 12.20, { open: 12.10, high: 12.25, low: 12.08, volume: 80_000 });
    const decision = evaluateGapHold(ctx({ impulseBar: impulse }), OPTS);
    assert.equal(decision.armed, true);
    assert.equal(decision.track, 'news_gap');
    assert.ok(decision.overnightGapPct !== null);
    assert.ok(Math.abs(decision.overnightGapPct - (12.0 - 9.0) / 9.0) < 1e-9);
    assert.ok((decision.stopPrice ?? 0) < (decision.entryPrice ?? 0));
    assert.ok(decision.score > 0);
    assert.match(describeGapHoldDecision(decision), /news_gap/);
  });

  it('rejects a 3% open-extension drifter (old OD spray)', () => {
    const impulse = bar(9 * 60 + 40, 10.40);
    const range = bar(9 * 60 + 30, 10.30, { low: 10.28, high: 10.32 });
    const decision = evaluateGapHold(
      ctx({
        symbol: 'DRIFT',
        impulseBar: impulse,
        rangeBar: range,
        sessionOpen: 10.30,
        previousClose: 10.00,
        sessionVwap: 10.32,
        oneMinBars: [range, impulse],
      }),
      OPTS,
    );
    assert.equal(decision.armed, false);
    assert.equal(decision.rejection, 'gap_out_of_band');
  });

  it('rejects when the RTH low has already filled the gap', () => {
    const range = bar(9 * 60 + 30, 12.0, { low: 11.80, high: 12.1 });
    const impulse = bar(9 * 60 + 40, 12.15, { low: 12.10, high: 12.20 });
    const decision = evaluateGapHold(
      ctx({
        impulseBar: impulse,
        rangeBar: range,
        oneMinBars: [range, impulse],
        sessionVwap: 12.0,
      }),
      OPTS,
    );
    assert.equal(decision.armed, false);
    assert.equal(decision.rejection, 'gap_filled');
  });

  it('rejects news_gap without a catalyst', () => {
    const impulse = bar(9 * 60 + 40, 12.20);
    const decision = evaluateGapHold(ctx({ impulseBar: impulse, catalystPasses: false }), OPTS);
    assert.equal(decision.armed, false);
    assert.equal(decision.rejection, 'no_catalyst');
  });

  it('rejects before 09:35', () => {
    const impulse = bar(9 * 60 + 32, 12.20);
    const decision = evaluateGapHold(
      ctx({ impulseBar: impulse, barMinutesSinceMidnight: 9 * 60 + 32 }),
      OPTS,
    );
    assert.equal(decision.armed, false);
    assert.equal(decision.rejection, 'outside_window');
  });
});

describe('evaluateGapHold — continuation', () => {
  it('arms when last clears yesterday high after a small overnight gap', () => {
    const range = bar(9 * 60 + 30, 25.50, { low: 25.45, high: 25.60 });
    const impulse = bar(9 * 60 + 42, 26.20, { open: 25.90, high: 26.30, low: 25.85, volume: 40_000 });
    const decision = evaluateGapHold(
      ctx({
        symbol: 'AEHR',
        impulseBar: impulse,
        rangeBar: range,
        previousClose: 25.00,
        previousHigh: 25.40,
        sessionOpen: 25.50,
        sessionVwap: 25.70,
        track: 'continuation',
        catalystPasses: true,
        oneMinBars: [range, impulse],
      }),
      OPTS,
    );
    assert.equal(decision.armed, true);
    assert.equal(decision.track, 'continuation');
  });

  it('rejects continuation that has not taken yesterday high', () => {
    const range = bar(9 * 60 + 30, 25.10, { low: 25.05, high: 25.20 });
    const impulse = bar(9 * 60 + 42, 25.30);
    const decision = evaluateGapHold(
      ctx({
        symbol: 'AEHR',
        impulseBar: impulse,
        rangeBar: range,
        previousClose: 25.00,
        previousHigh: 25.80,
        sessionOpen: 25.10,
        sessionVwap: 25.15,
        track: 'continuation',
        oneMinBars: [range, impulse],
      }),
      OPTS,
    );
    assert.equal(decision.armed, false);
    assert.equal(decision.rejection, 'no_breakout');
  });
});
