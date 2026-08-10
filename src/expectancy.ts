import type { TradeRecord } from './types';

/** Spec §6 scenario labels (issue #5 naming). */
export type ExpectancyScenario =
  | 'Break-even'
  | 'Robustesse'
  | 'Standard'
  | 'Sniper';

export interface ExpectancyMetrics {
  n: number;
  winRate: number;
  avgWinR: number;
  avgLossR: number;
  eR: number;
  scenario: ExpectancyScenario | null;
}

export interface RollingExpectancy {
  session: ExpectancyMetrics;
  last20: ExpectancyMetrics;
  last50: ExpectancyMetrics;
}

interface ScenarioAnchor {
  label: ExpectancyScenario;
  winRate: number;
  eR: number;
}

const SCENARIO_ANCHORS: readonly ScenarioAnchor[] = [
  { label: 'Break-even', winRate: 0.333, eR: 0.0 },
  { label: 'Robustesse', winRate: 0.6, eR: 0.8 },
  { label: 'Standard', winRate: 0.714, eR: 1.14 },
  { label: 'Sniper', winRate: 0.8, eR: 1.4 },
] as const;

export const EMPTY_EXPECTANCY: ExpectancyMetrics = {
  n: 0,
  winRate: 0,
  avgWinR: 0,
  avgLossR: 0,
  eR: 0,
  scenario: null,
};

/** Soft-fill missing V7 R fields on legacy journal rows. */
export function normalizeTradeRecord(record: TradeRecord): TradeRecord {
  return {
    ...record,
    equity_at_entry: record.equity_at_entry ?? null,
    risk_dollars_at_entry: record.risk_dollars_at_entry ?? null,
    pnl_r: record.pnl_r ?? null,
  };
}

export function normalizeTradeRecords(records: TradeRecord[]): TradeRecord[] {
  return records.map(normalizeTradeRecord);
}

/** pnl_r = net_pnl_dollars / risk_dollars_at_entry when risk > 0. */
export function computePnlR(
  netPnlDollars: number,
  riskDollarsAtEntry: number,
): number | null {
  if (!Number.isFinite(netPnlDollars) || !Number.isFinite(riskDollarsAtEntry)) {
    return null;
  }
  if (riskDollarsAtEntry <= 0) return null;
  return netPnlDollars / riskDollarsAtEntry;
}

/**
 * Prefer actual stop risk (stopDistance × qty); fallback to equity × riskPct.
 */
export function resolveRiskDollarsAtEntry(
  stopDistance: number,
  qty: number,
  equityAtEntry: number,
  riskPerTradePct: number,
): number {
  const fromStop = stopDistance * qty;
  if (Number.isFinite(fromStop) && fromStop > 0) return fromStop;
  if (Number.isFinite(equityAtEntry) && equityAtEntry > 0 && riskPerTradePct > 0) {
    return equityAtEntry * riskPerTradePct;
  }
  return 0;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Map observed WR + E_R to the nearest scenario anchor (euclidean distance).
 */
export function classifyScenario(winRate: number, eR: number): ExpectancyScenario {
  let best: ScenarioAnchor = SCENARIO_ANCHORS[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const anchor of SCENARIO_ANCHORS) {
    const dWr = winRate - anchor.winRate;
    const dE = eR - anchor.eR;
    const dist = Math.hypot(dWr, dE);
    if (dist < bestDist) {
      bestDist = dist;
      best = anchor;
    }
  }
  return best.label;
}

/**
 * E = WR * AvgWin_R - LossRate * AvgLoss_R
 * AvgLoss_R uses absolute magnitude of losing pnl_r.
 * Only trades with non-null pnl_r are included (soft migration).
 */
export function computeExpectancyMetrics(
  trades: readonly TradeRecord[],
): ExpectancyMetrics {
  const withR = trades.filter(
    (t): t is TradeRecord & { pnl_r: number } =>
      t.exit_time !== null && t.pnl_r !== null && Number.isFinite(t.pnl_r),
  );

  if (withR.length === 0) return { ...EMPTY_EXPECTANCY };

  const winners = withR.filter(t => t.pnl_r > 0);
  const losers = withR.filter(t => t.pnl_r <= 0);
  const winRate = winners.length / withR.length;
  const lossRate = losers.length / withR.length;
  const avgWinR = average(winners.map(t => t.pnl_r));
  const avgLossR = average(losers.map(t => Math.abs(t.pnl_r)));
  const eR = winRate * avgWinR - lossRate * avgLossR;

  return {
    n: withR.length,
    winRate,
    avgWinR,
    avgLossR,
    eR,
    scenario: classifyScenario(winRate, eR),
  };
}

function isClosed(record: TradeRecord): boolean {
  return record.exit_time !== null;
}

function sortByExitTime(a: TradeRecord, b: TradeRecord): number {
  const ta = a.exit_time ?? '';
  const tb = b.exit_time ?? '';
  return ta.localeCompare(tb);
}

/**
 * Rolling expectancy: session (entry_time prefix) + last 20 / last 50 closed with R.
 */
export function computeRollingExpectancy(
  closedRecords: readonly TradeRecord[],
  sessionDatePrefix: string,
): RollingExpectancy {
  const closed = normalizeTradeRecords([...closedRecords].filter(isClosed))
    .sort(sortByExitTime);

  const session = closed.filter(r => r.entry_time.startsWith(sessionDatePrefix));
  const withR = closed.filter(r => r.pnl_r !== null && Number.isFinite(r.pnl_r));

  return {
    session: computeExpectancyMetrics(session),
    last20: computeExpectancyMetrics(withR.slice(-20)),
    last50: computeExpectancyMetrics(withR.slice(-50)),
  };
}

export function formatExpectancyLine(label: string, m: ExpectancyMetrics): string {
  if (m.n === 0) return `${label}: n=0`;
  const scenario = m.scenario ?? 'N/A';
  return (
    `${label}: n=${m.n} WR=${(m.winRate * 100).toFixed(1)}% ` +
    `AvgWin=${m.avgWinR.toFixed(2)}R AvgLoss=${m.avgLossR.toFixed(2)}R ` +
    `E=${m.eR >= 0 ? '+' : ''}${m.eR.toFixed(2)}R [${scenario}]`
  );
}
