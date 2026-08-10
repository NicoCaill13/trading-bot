import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyScenario,
  computeExpectancyMetrics,
  computePnlR,
  computeRollingExpectancy,
  normalizeTradeRecord,
  resolveRiskDollarsAtEntry,
} from '../src/expectancy';
import type { TradeRecord } from '../src/types';

function baseTrade(overrides: Partial<TradeRecord>): TradeRecord {
  return normalizeTradeRecord({
    symbol: 'TEST',
    origin: 'V1_CORE',
    alpha_vs_spy: null,
    gap_percentage: null,
    relative_volume: null,
    entry_time: '2026-08-10T14:00:00.000Z',
    entry_price: 100,
    qty: 10,
    vwap_at_entry: 100,
    ema9_at_entry: null,
    sma20_at_entry: null,
    distance_to_sma20_percent: null,
    spy_trend_5m: 'bullish',
    scale_out_price: null,
    scale_out_qty: null,
    scale_out_reason: null,
    fib_level_at_entry: null,
    fib_level_name_at_entry: null,
    exit_time: '2026-08-10T15:00:00.000Z',
    exit_price: 102,
    exit_reason: 'target-atr',
    net_pnl_dollars: 20,
    net_pnl_percentage: 2,
    mfe_percent: 2,
    mae_percent: -0.5,
    equity_at_entry: 10_000,
    risk_dollars_at_entry: 100,
    pnl_r: null,
    ...overrides,
  });
}

/** Build N wins at +2R and M losses at -1R (classic 2R:1R payoff). */
function fixtureRr21(wins: number, losses: number): TradeRecord[] {
  const trades: TradeRecord[] = [];
  for (let i = 0; i < wins; i++) {
    trades.push(baseTrade({
      symbol: `W${i}`,
      pnl_r: 2,
      net_pnl_dollars: 200,
      exit_time: `2026-08-10T15:${String(i).padStart(2, '0')}:00.000Z`,
    }));
  }
  for (let i = 0; i < losses; i++) {
    trades.push(baseTrade({
      symbol: `L${i}`,
      pnl_r: -1,
      net_pnl_dollars: -100,
      exit_reason: 'stop-loss-initial',
      exit_time: `2026-08-10T16:${String(i).padStart(2, '0')}:00.000Z`,
    }));
  }
  return trades;
}

describe('computePnlR', () => {
  it('divides pnl by risk', () => {
    assert.equal(computePnlR(50, 100), 0.5);
    assert.equal(computePnlR(-25, 100), -0.25);
  });

  it('returns null when risk is non-positive', () => {
    assert.equal(computePnlR(10, 0), null);
    assert.equal(computePnlR(10, -1), null);
  });
});

describe('resolveRiskDollarsAtEntry', () => {
  it('prefers stop distance × qty', () => {
    assert.equal(resolveRiskDollarsAtEntry(1.5, 10, 10_000, 0.01), 15);
  });

  it('falls back to equity × risk pct', () => {
    assert.equal(resolveRiskDollarsAtEntry(0, 0, 10_000, 0.01), 100);
  });
});

describe('computeExpectancyMetrics + classifyScenario', () => {
  it('Break-even: WR 33.3% E ≈ 0 with 2R/1R payoff', () => {
    // 1 win + 2 losses
    const m = computeExpectancyMetrics(fixtureRr21(1, 2));
    assert.equal(m.n, 3);
    assert.ok(Math.abs(m.winRate - 1 / 3) < 1e-9);
    assert.ok(Math.abs(m.eR) < 1e-9);
    assert.equal(m.scenario, 'Break-even');
    assert.equal(classifyScenario(m.winRate, m.eR), 'Break-even');
  });

  it('Robustesse: WR 60% E ≈ +0.80R', () => {
    // 3 wins + 2 losses
    const m = computeExpectancyMetrics(fixtureRr21(3, 2));
    assert.equal(m.n, 5);
    assert.ok(Math.abs(m.winRate - 0.6) < 1e-9);
    assert.ok(Math.abs(m.eR - 0.8) < 1e-9);
    assert.equal(m.scenario, 'Robustesse');
  });

  it('Standard: WR 71.4% E ≈ +1.14R', () => {
    // 5 wins + 2 losses ≈ 71.4%
    const m = computeExpectancyMetrics(fixtureRr21(5, 2));
    assert.equal(m.n, 7);
    assert.ok(Math.abs(m.winRate - 5 / 7) < 1e-9);
    assert.ok(Math.abs(m.eR - (5 / 7 * 2 - 2 / 7 * 1)) < 1e-9);
    assert.equal(m.scenario, 'Standard');
  });

  it('Sniper: WR 80% E ≈ +1.40R', () => {
    // 4 wins + 1 loss
    const m = computeExpectancyMetrics(fixtureRr21(4, 1));
    assert.equal(m.n, 5);
    assert.ok(Math.abs(m.winRate - 0.8) < 1e-9);
    assert.ok(Math.abs(m.eR - 1.4) < 1e-9);
    assert.equal(m.scenario, 'Sniper');
  });

  it('excludes trades without pnl_r (soft migration)', () => {
    const trades = [
      ...fixtureRr21(4, 1),
      baseTrade({ symbol: 'LEGACY', pnl_r: null, risk_dollars_at_entry: null }),
    ];
    const m = computeExpectancyMetrics(trades);
    assert.equal(m.n, 5);
  });

  it('returns empty metrics when no R data', () => {
    const m = computeExpectancyMetrics([
      baseTrade({ pnl_r: null, exit_time: '2026-08-10T15:00:00.000Z' }),
    ]);
    assert.equal(m.n, 0);
    assert.equal(m.scenario, null);
  });
});

describe('computeRollingExpectancy', () => {
  it('splits session vs last20/last50', () => {
    const session = fixtureRr21(4, 1).map(t => ({
      ...t,
      entry_time: '2026-08-10T14:00:00.000Z',
    }));
    const prior = fixtureRr21(1, 2).map((t, i) => ({
      ...t,
      symbol: `P${i}`,
      entry_time: '2026-08-09T14:00:00.000Z',
      exit_time: `2026-08-09T15:0${i}:00.000Z`,
    }));
    const rolling = computeRollingExpectancy([...prior, ...session], '2026-08-10');
    assert.equal(rolling.session.n, 5);
    assert.equal(rolling.session.scenario, 'Sniper');
    assert.equal(rolling.last20.n, 8);
    assert.equal(rolling.last50.n, 8);
  });
});

describe('normalizeTradeRecord', () => {
  it('fills missing R fields with null', () => {
    const legacy = { ...baseTrade({}), equity_at_entry: undefined as unknown as null };
    delete (legacy as { equity_at_entry?: number | null }).equity_at_entry;
    delete (legacy as { risk_dollars_at_entry?: number | null }).risk_dollars_at_entry;
    delete (legacy as { pnl_r?: number | null }).pnl_r;
    const n = normalizeTradeRecord(legacy as TradeRecord);
    assert.equal(n.equity_at_entry, null);
    assert.equal(n.risk_dollars_at_entry, null);
    assert.equal(n.pnl_r, null);
  });
});
