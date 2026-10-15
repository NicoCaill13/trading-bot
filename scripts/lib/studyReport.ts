/**
 * Shared formatting for the eligible-mover studies, so both print the same
 * columns and apply the same validation gate.
 */

import type { TradeSample, TradeStats } from './eligibleStudy';
import type { StudyRow } from './studyCache';

export const formatPct = (value: number): string => `${(value * 100).toFixed(1)}%`;

/** Simulated rows as trades, net of a flat round-trip cost. Unsimulated rows are skipped. */
export function toTradeSamples(rows: readonly StudyRow[], costPct: number): TradeSample[] {
  const trades: TradeSample[] = [];
  for (const row of rows) {
    if (row.sim === null) continue;
    trades.push({
      session: row.session,
      symbol: row.symbol,
      outcome: row.sim.outcome,
      netReturnPct: row.sim.returnPct - costPct,
    });
  }
  return trades;
}

/** A rule is validated only with enough trades and a positive day-clustered CI. */
export function gateLabel(stats: TradeStats, minTrades: number): string {
  if (stats.n < minTrades) return 'too few';
  return stats.clusteredCi95LowPct > 0 ? 'PASS' : 'fail';
}

export function formatTradeLine(
  name: string,
  selectedCount: number,
  stats: TradeStats,
  sessionCount: number,
  stopPct: number,
  minTrades: number,
): string {
  const rMultiple = stopPct > 0 ? stats.meanNetPct / stopPct : 0;
  return (
    `  ${name.padEnd(40)} ` +
    `sel ${String(selectedCount).padStart(5)} ` +
    `trd ${String(stats.n).padStart(5)} ` +
    `${(stats.n / Math.max(1, sessionCount)).toFixed(2).padStart(5)}/s ` +
    `tgt ${formatPct(stats.targetRate).padStart(6)} ` +
    `stp ${formatPct(stats.stopRate).padStart(6)} ` +
    `net ${stats.meanNetPct.toFixed(2).padStart(6)}% ` +
    `[${stats.clusteredCi95LowPct.toFixed(2)}, ${stats.clusteredCi95HighPct.toFixed(2)}] ` +
    `${rMultiple.toFixed(2).padStart(5)}R ` +
    `sym ${String(stats.distinctSymbols).padStart(4)} ` +
    `top3 ${formatPct(stats.top3ProfitShare).padStart(6)}  ${gateLabel(stats, minTrades)}`
  );
}
