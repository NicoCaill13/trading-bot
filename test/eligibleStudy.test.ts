import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RawBar } from '../scripts/lib/barFetch';
import {
  FEATURE_LOOKBACK,
  STUDY_RULES,
  bucketPrecision,
  computeOpeningConfirm,
  computePreOpenFeatures,
  isDerivativeSymbol,
  simulateIntraday,
  summarizeTrades,
  type PreOpenFeatures,
} from '../scripts/lib/eligibleStudy';

function dailyBar(i: number, c: number, h = c, l = c, v = 1_000): RawBar {
  return { t: `d${i}`, o: c, h, l, c, v };
}

function flatHistory(close: number, count = FEATURE_LOOKBACK + 1): RawBar[] {
  return Array.from({ length: count }, (_, i) => dailyBar(i, close));
}

describe('computePreOpenFeatures', () => {
  it('returns null without enough history', () => {
    assert.equal(computePreOpenFeatures(flatHistory(10, FEATURE_LOOKBACK), 10), null);
  });

  it('computes gap against the last close in percent', () => {
    const f = computePreOpenFeatures(flatHistory(10), 11);
    assert.ok(f);
    assert.ok(Math.abs(f.gapPct - 10) < 1e-9);
    assert.equal(f.prevClose, 10);
  });

  it('measures distance below the lookback high and the close location', () => {
    const history = flatHistory(10);
    history[history.length - 1] = dailyBar(99, 10, 10.4, 9.6);
    history[history.length - 5] = dailyBar(98, 10, 12, 10);
    const f = computePreOpenFeatures(history, 10);
    assert.ok(f);
    assert.ok(Math.abs(f.distanceFromHighPct - 20) < 1e-9);
    assert.ok(Math.abs(f.prevCloseLocation - 0.5) < 1e-9);
  });

  it('flags a dollar-volume spike on the previous session', () => {
    const history = flatHistory(10);
    history[history.length - 1] = dailyBar(99, 10, 10, 10, 5_000);
    const f = computePreOpenFeatures(history, 10);
    assert.ok(f);
    assert.ok(f.dollarVolumeRatio > 3);
  });

  it('does not read the session open into prior-day features', () => {
    const a = computePreOpenFeatures(flatHistory(10), 10);
    const b = computePreOpenFeatures(flatHistory(10), 13);
    assert.ok(a && b);
    assert.equal(a.atrPct20, b.atrPct20);
    assert.equal(a.prevReturnPct, b.prevReturnPct);
  });
});

describe('simulateIntraday', () => {
  const minutesOf = (t: string): number => Number(t);
  const opts = { entryMinute: 574, endMinute: 955, targetPct: 10, stopPct: 3, minutesOf };

  function bar(minute: number, o: number, h: number, l: number, c: number): RawBar {
    return { t: String(minute), o, h, l, c, v: 100 };
  }

  it('returns null when the entry bar is missing', () => {
    assert.equal(simulateIntraday([bar(575, 10, 10, 10, 10)], opts), null);
  });

  it('reports a target hit', () => {
    const r = simulateIntraday(
      [bar(574, 10, 10, 10, 10), bar(600, 10, 11.2, 9.9, 11)],
      opts,
    );
    assert.equal(r?.outcome, 'target');
    assert.equal(r?.entryPrice, 10);
  });

  it('reports a stop hit before a later target', () => {
    const r = simulateIntraday(
      [bar(574, 10, 10, 10, 10), bar(580, 10, 10, 9.6, 9.7), bar(600, 10, 11.5, 9.7, 11)],
      opts,
    );
    assert.equal(r?.outcome, 'stop');
  });

  it('counts a bar touching both levels as stopped', () => {
    const r = simulateIntraday(
      [bar(574, 10, 10, 10, 10), bar(580, 10, 11.5, 9.6, 10)],
      opts,
    );
    assert.equal(r?.outcome, 'stop');
  });

  it('ignores bars after the end minute and stays open', () => {
    const r = simulateIntraday(
      [bar(574, 10, 10, 10, 10), bar(600, 10, 10.5, 9.9, 10.2), bar(960, 10, 12, 9, 10)],
      opts,
    );
    assert.equal(r?.outcome, 'open');
    assert.ok(Math.abs((r?.maxFavourablePct ?? 0) - 5) < 1e-9);
  });
});

describe('simulateIntraday returnPct', () => {
  const minutesOf = (t: string): number => Number(t);
  const opts = { entryMinute: 574, endMinute: 955, targetPct: 10, stopPct: 3, minutesOf };

  function bar(minute: number, o: number, h: number, l: number, c: number): RawBar {
    return { t: String(minute), o, h, l, c, v: 100 };
  }

  it('books the target level on a target hit', () => {
    const r = simulateIntraday([bar(574, 10, 10, 10, 10), bar(600, 10, 11.5, 10, 11)], opts);
    assert.equal(r?.returnPct, 10);
  });

  it('books the stop level when the bar trades through it', () => {
    const r = simulateIntraday([bar(574, 10, 10, 10, 10), bar(600, 10, 10, 9.5, 9.6)], opts);
    assert.ok(Math.abs((r?.returnPct ?? 0) + 3) < 1e-9);
  });

  it('books the bar open when a bar gaps below the stop', () => {
    const r = simulateIntraday([bar(574, 10, 10, 10, 10), bar(600, 9.2, 9.4, 9.1, 9.3)], opts);
    assert.ok(Math.abs((r?.returnPct ?? 0) + 8) < 1e-9);
  });

  it('marks an open trade to the last close inside the window', () => {
    const r = simulateIntraday(
      [bar(574, 10, 10, 10, 10), bar(600, 10, 10.4, 9.9, 10.3), bar(960, 10, 10, 5, 5)],
      opts,
    );
    assert.equal(r?.outcome, 'open');
    assert.ok(Math.abs((r?.returnPct ?? 0) - 3) < 1e-9);
  });
});

describe('isDerivativeSymbol', () => {
  it('flags five-letter warrants, rights and units', () => {
    assert.equal(isDerivativeSymbol('PSNYW'), true);
    assert.equal(isDerivativeSymbol('USDEW'), true);
    assert.equal(isDerivativeSymbol('ABCDR'), true);
    assert.equal(isDerivativeSymbol('ABCDU'), true);
  });

  it('keeps ordinary tickers, including short ones ending in those letters', () => {
    assert.equal(isDerivativeSymbol('AAPL'), false);
    assert.equal(isDerivativeSymbol('XRPN'), false);
    assert.equal(isDerivativeSymbol('CAR'), false);
    assert.equal(isDerivativeSymbol('LYFT'), false);
  });
});

describe('computeOpeningConfirm', () => {
  const minutesOf = (t: string): number => Number(t);
  const opts = { openMinute: 570, entryMinute: 574, minutesOf };

  function bar(minute: number, o: number, h: number, l: number, c: number, v = 100): RawBar {
    return { t: String(minute), o, h, l, c, v };
  }

  it('returns null when the name never printed at the entry minute', () => {
    assert.equal(computeOpeningConfirm([bar(570, 10, 10, 10, 10)], opts), null);
  });

  it('flags a name holding above its open and VWAP', () => {
    const bars = [bar(570, 10, 10, 10, 10), bar(572, 10, 10.2, 10, 10.1), bar(574, 10.1, 10.6, 10.1, 10.5)];
    const c = computeOpeningConfirm(bars, opts);
    assert.ok(c);
    assert.ok(Math.abs(c.fromOpenPct - 5) < 1e-9);
    assert.equal(c.aboveVwap, true);
  });

  it('flags a name that faded below its VWAP', () => {
    const bars = [bar(570, 10, 11, 10, 10.9, 1000), bar(574, 10.9, 10.9, 10, 10, 100)];
    const c = computeOpeningConfirm(bars, opts);
    assert.ok(c);
    assert.equal(c.aboveVwap, false);
  });

  it('ignores bars after the entry minute', () => {
    const bars = [bar(570, 10, 10, 10, 10), bar(574, 10, 10, 10, 10), bar(580, 10, 99, 10, 99, 1_000_000)];
    const c = computeOpeningConfirm(bars, opts);
    assert.ok(c);
    assert.equal(c.fromOpenPct, 0);
  });
});

describe('summarizeTrades', () => {
  it('returns zeros for no trades', () => {
    const s = summarizeTrades([]);
    assert.equal(s.n, 0);
    assert.equal(s.meanNetPct, 0);
  });

  it('computes rates, mean and distinct symbols', () => {
    const s = summarizeTrades([
      { session: 'd1', symbol: 'A', outcome: 'target', netReturnPct: 9 },
      { session: 'd2', symbol: 'B', outcome: 'stop', netReturnPct: -4 },
      { session: 'd3', symbol: 'B', outcome: 'stop', netReturnPct: -4 },
      { session: 'd4', symbol: 'C', outcome: 'open', netReturnPct: 1 },
    ]);
    assert.equal(s.n, 4);
    assert.equal(s.days, 4);
    assert.equal(s.distinctSymbols, 3);
    assert.equal(s.targetRate, 0.25);
    assert.equal(s.stopRate, 0.5);
    assert.ok(Math.abs(s.meanNetPct - 0.5) < 1e-9);
    assert.ok(s.ci95LowPct < s.meanNetPct && s.meanNetPct < s.ci95HighPct);
  });

  it('measures how much profit the three best symbols carry', () => {
    const trades = ['A', 'B', 'C', 'D'].map((symbol, i) => ({
      session: `d${i}`,
      symbol,
      outcome: 'target' as const,
      netReturnPct: 5,
    }));
    assert.equal(summarizeTrades(trades).top3ProfitShare, 0.75);
  });

  it('reports no profit share when nothing is profitable', () => {
    const s = summarizeTrades([
      { session: 'd1', symbol: 'A', outcome: 'stop', netReturnPct: -4 },
    ]);
    assert.equal(s.top3ProfitShare, 0);
  });

  it('widens the interval when trades of the same session move together', () => {
    const sample = (session: string, symbol: string, netReturnPct: number) => ({
      session,
      symbol,
      outcome: 'open' as const,
      netReturnPct,
    });
    // Same returns, two arrangements: errors cancel inside each session, or pile up.
    const cancelling = summarizeTrades([
      sample('d1', 'A', 2), sample('d1', 'B', -2),
      sample('d2', 'C', 2), sample('d2', 'D', -2),
    ]);
    const clustered = summarizeTrades([
      sample('d1', 'A', 2), sample('d1', 'B', 2),
      sample('d2', 'C', -2), sample('d2', 'D', -2),
    ]);
    const width = (s: { clusteredCi95LowPct: number; clusteredCi95HighPct: number }): number =>
      s.clusteredCi95HighPct - s.clusteredCi95LowPct;

    assert.ok(Math.abs(cancelling.ci95HighPct - clustered.ci95HighPct) < 1e-9);
    assert.ok(width(clustered) > width(cancelling));
    assert.equal(width(cancelling), 0);
  });

  it('falls back to the naive interval with a single session', () => {
    const s = summarizeTrades([
      { session: 'd1', symbol: 'A', outcome: 'target', netReturnPct: 9 },
      { session: 'd1', symbol: 'B', outcome: 'stop', netReturnPct: -4 },
    ]);
    assert.equal(s.days, 1);
    assert.equal(s.clusteredCi95LowPct, s.ci95LowPct);
  });
});

describe('STUDY_RULES', () => {
  const base: PreOpenFeatures = {
    prevClose: 10,
    gapPct: 0,
    prevReturnPct: 0,
    prevCloseLocation: 0.5,
    atrPct20: 3,
    prevDollarVolume: 10_000_000,
    dollarVolumeRatio: 1,
    distanceFromHighPct: 10,
  };

  function selectedBy(features: PreOpenFeatures): string[] {
    return STUDY_RULES.filter(r => r.selects(features)).map(r => r.name);
  }

  it('selects nothing for an unremarkable name', () => {
    assert.deepEqual(selectedBy(base), []);
  });

  it('selects a large gap with a volume spike', () => {
    const names = selectedBy({ ...base, gapPct: 12, dollarVolumeRatio: 3 });
    assert.ok(names.includes('gap>=8'));
    assert.ok(names.includes('gap>=8 & vol>=2x'));
    assert.ok(!names.includes('atr>=8 & vol>=2x'));
  });

  it('selects a volatile name with a volume spike without a gap', () => {
    const names = selectedBy({ ...base, atrPct20: 9, dollarVolumeRatio: 2.5 });
    assert.deepEqual(names, ['atr>=8 & vol>=2x']);
  });
});

describe('bucketPrecision', () => {
  const rows = [
    { v: 1, hit: false },
    { v: 2, hit: false },
    { v: 5, hit: true },
    { v: 6, hit: false },
    { v: 20, hit: true },
  ];

  it('splits on edges and reports precision and lift', () => {
    const out = bucketPrecision(rows, r => r.v, r => r.hit, [3, 10], 0.4);
    assert.deepEqual(out.map(b => [b.label, b.n, b.hits]), [
      ['< 3', 2, 0],
      ['3 .. 10', 2, 1],
      ['>= 10', 1, 1],
    ]);
    assert.ok(Math.abs(out[1].precision - 0.5) < 1e-9);
    assert.ok(Math.abs(out[2].lift - 2.5) < 1e-9);
  });

  it('reports zero lift when the base rate is zero', () => {
    const out = bucketPrecision(rows, r => r.v, () => false, [3], 0);
    assert.equal(out[0].lift, 0);
  });
});
