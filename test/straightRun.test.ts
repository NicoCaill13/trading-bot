import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessStraightRun,
  computeVolumeRatio,
  type StraightRunBar,
  type StraightRunOptions,
} from '../src/straightRun';

const OPTS: StraightRunOptions = {
  minDays: 5,
  maxDrawdownPct: 0.04,
  minMarketRelativeRvol: 1.0,
  rvolBaselineDays: 14,
};

/** A flat market: the symbol's own ratio is already the market-relative one. */
const FLAT_MARKET = 1;

/** Ratios come out of two divisions, so exact equality is not available. */
function assertRatio(actual: number, expected: number): void {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `expected ~${expected}, got ${actual}`,
  );
}

function bar(close: number, volume = 1_000, high = close, low = close): StraightRunBar {
  return { high, low, close, volume };
}

/** `rvolBaselineDays` flat sessions, so the baseline volume is exactly `volume`. */
function baseline(close: number, volume = 1_000): StraightRunBar[] {
  return Array.from({ length: OPTS.rvolBaselineDays }, () => bar(close, volume));
}

function straightRunBars(volume = 1_000): StraightRunBar[] {
  return [...baseline(100, volume), ...[101, 102, 103, 104, 105].map(c => bar(c, volume))];
}

describe('computeVolumeRatio', () => {
  it('divides the window mean by the preceding baseline mean', () => {
    const bars = [...baseline(100, 1_000), ...[101, 102, 103, 104, 105].map(c => bar(c, 2_500))];
    assertRatio(computeVolumeRatio(bars, 5, 14) ?? 0, 2.5);
  });

  it('returns null when history is too short', () => {
    assert.equal(computeVolumeRatio(baseline(100), 5, 14), null);
  });

  it('returns null on a zero baseline rather than dividing by zero', () => {
    const bars = [...baseline(100, 0), ...[101, 102, 103, 104, 105].map(c => bar(c, 1_000))];
    assert.equal(computeVolumeRatio(bars, 5, 14), null);
  });

  it('rejects nonsensical window lengths', () => {
    assert.equal(computeVolumeRatio(straightRunBars(), 0, 14), null);
    assert.equal(computeVolumeRatio(straightRunBars(), 5, 0), null);
  });
});

describe('assessStraightRun — history guard', () => {
  it('returns null below minDays + rvolBaselineDays bars', () => {
    assert.equal(assessStraightRun(baseline(100), OPTS, FLAT_MARKET), null);
  });

  it('returns null on a nonsensical window', () => {
    const bars = straightRunBars();
    assert.equal(assessStraightRun(bars, { ...OPTS, minDays: 1 }, FLAT_MARKET), null);
    assert.equal(assessStraightRun(bars, { ...OPTS, maxDrawdownPct: 0 }, FLAT_MARKET), null);
  });
});

describe('assessStraightRun — consecutive closes branch', () => {
  it('tags five straight up closes', () => {
    const result = assessStraightRun(straightRunBars(), OPTS, FLAT_MARKET);

    assert.ok(result);
    assert.equal(result.isStraightRun, true);
    assert.equal(result.trigger, 'consecutive_closes');
    assert.equal(result.consecutiveUpDays, 5);
    assert.equal(result.drawdownPct, 0);
    assert.ok(result.score > 0);
  });

  it('does not tag four up closes when five are required', () => {
    // Highs kept above the final close so the breakout branch cannot arm instead.
    const bars = [
      ...baseline(100),
      ...[99, 100, 101, 102, 103].map(c => bar(c, 1_000, 110)),
    ];

    const result = assessStraightRun(bars, OPTS, FLAT_MARKET);

    assert.ok(result);
    assert.equal(result.consecutiveUpDays, 4);
    assert.equal(result.trigger, null);
    assert.equal(result.isStraightRun, false);
    assert.equal(result.score, 0);
  });
});

describe('assessStraightRun — range breakout branch', () => {
  it('tags a zigzag that closes above the window high', () => {
    const bars = [
      ...baseline(100),
      bar(101, 1_000, 102),
      bar(100, 1_000, 101),
      bar(101, 1_000, 102),
      bar(100, 1_000, 101),
      bar(103, 1_000, 103),
    ];

    const result = assessStraightRun(bars, OPTS, FLAT_MARKET);

    assert.ok(result);
    assert.equal(result.trigger, 'range_breakout');
    assert.equal(result.isStraightRun, true);
  });

  it('rejects a breakout whose window drawdown is too deep', () => {
    const bars = [
      ...baseline(100),
      bar(100, 1_000, 101),
      bar(90, 1_000, 100),
      bar(95, 1_000, 96),
      bar(98, 1_000, 99),
      bar(105, 1_000, 105),
    ];

    const result = assessStraightRun(bars, OPTS, FLAT_MARKET);

    assert.ok(result);
    assert.equal(result.trigger, 'range_breakout');
    assert.equal(result.isStraightRun, false);
    assert.ok(result.drawdownPct > OPTS.maxDrawdownPct);
  });

  it('does not let the breakout bar clear its own high', () => {
    const bars = [
      ...baseline(100),
      ...Array.from({ length: 4 }, () => bar(100, 1_000, 100)),
      bar(100, 1_000, 120),
    ];

    const result = assessStraightRun(bars, OPTS, FLAT_MARKET);

    assert.ok(result);
    assert.equal(result.trigger, null);
  });
});

describe('assessStraightRun — market-relative volume', () => {
  it('normalises the symbol ratio by the benchmark ratio', () => {
    const bars = [...baseline(100, 1_000), ...[101, 102, 103, 104, 105].map(c => bar(c, 800))];

    const result = assessStraightRun(bars, OPTS, 0.5);

    assert.ok(result);
    assertRatio(result.volumeRatio, 0.8);
    assertRatio(result.marketRelativeRvol, 1.6);
    assert.equal(result.isStraightRun, true);
  });

  it('tags a run whose absolute volume fell but beat the market trough', () => {
    // The WDC case: absolute 0.96x, market at 0.75x -> relative 1.28x.
    const bars = [...baseline(100, 1_000), ...[101, 102, 103, 104, 105].map(c => bar(c, 960))];

    const result = assessStraightRun(bars, OPTS, 0.75);

    assert.ok(result);
    assert.ok(result.volumeRatio < 1);
    assert.ok(result.marketRelativeRvol > 1);
    assert.equal(result.isStraightRun, true);
  });

  it('rejects a run that lagged a rising market', () => {
    const bars = [...baseline(100, 1_000), ...[101, 102, 103, 104, 105].map(c => bar(c, 1_200))];

    const result = assessStraightRun(bars, OPTS, 1.5);

    assert.ok(result);
    assertRatio(result.volumeRatio, 1.2);
    assertRatio(result.marketRelativeRvol, 0.8);
    assert.equal(result.isStraightRun, false);
  });

  it('withholds the tag when the benchmark ratio is unavailable', () => {
    const result = assessStraightRun(straightRunBars(), OPTS, 0);

    assert.ok(result);
    assert.equal(result.marketRelativeRvol, 0);
    assert.equal(result.isStraightRun, false);
  });

  it('treats a zero baseline as no conviction', () => {
    const bars = [...baseline(100, 0), ...[101, 102, 103, 104, 105].map(c => bar(c, 1_000))];

    const result = assessStraightRun(bars, OPTS, FLAT_MARKET);

    assert.ok(result);
    assert.equal(result.volumeRatio, 0);
    assert.equal(result.isStraightRun, false);
  });
});

describe('assessStraightRun — score', () => {
  it('stays within 0..1', () => {
    const bars = [
      ...baseline(100, 1_000),
      ...[110, 120, 130, 140, 150].map(c => bar(c, 100_000)),
    ];

    const score = assessStraightRun(bars, OPTS, FLAT_MARKET)?.score ?? -1;

    assert.ok(score > 0 && score <= 1, `score out of range: ${score}`);
  });

  it('ranks a smoother run above a choppier one at equal volume', () => {
    const smooth = [...baseline(100), ...[102, 104, 106, 108, 110].map(c => bar(c))];
    const choppy = [
      ...baseline(100),
      bar(101, 1_000, 102),
      bar(99, 1_000, 101),
      bar(103, 1_000, 103),
      bar(102, 1_000, 104),
      bar(110, 1_000, 110),
    ];

    const smoothScore = assessStraightRun(smooth, OPTS, FLAT_MARKET)?.score ?? 0;
    const choppyScore = assessStraightRun(choppy, OPTS, FLAT_MARKET)?.score ?? 0;

    assert.ok(smoothScore > choppyScore, `${smoothScore} <= ${choppyScore}`);
  });

  it('is zero whenever the tag is not armed', () => {
    const bars = [...baseline(100), ...[99, 98, 97, 96, 95].map(c => bar(c))];
    assert.equal(assessStraightRun(bars, OPTS, FLAT_MARKET)?.score, 0);
  });
});

describe('assessStraightRun — drawdown is measured on closes', () => {
  it('ignores intraday range, which every ADR>4% candidate would breach', () => {
    // Straight closes, but each session swings 8% between low and high.
    const bars = [
      ...baseline(100),
      ...[101, 102, 103, 104, 105].map(c => bar(c, 1_000, c * 1.04, c * 0.96)),
    ];

    const result = assessStraightRun(bars, OPTS, FLAT_MARKET);

    assert.ok(result);
    assert.equal(result.drawdownPct, 0);
    assert.equal(result.isStraightRun, true);
  });
});
