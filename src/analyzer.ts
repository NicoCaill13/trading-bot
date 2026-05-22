import fs from 'fs/promises';
import path from 'path';
import config from './config';
import { createLogger } from './logger';
import { sendTelegramAlert } from './notificationManager';
import type { TradeRecord } from './types';

const log = createLogger('ANALYZER');

// ---------------------------------------------------------------------------
// KPI computation helpers
// ---------------------------------------------------------------------------

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

interface BestSetup {
  description: string;
  totalPnlDollars: number;
  recordCount: number;
  bestSymbol: string;
}

/**
 * Identifies the best-performing setup from a set of records.
 * Priority: high-RVOL (> 3x) subset → per-origin bucket → best individual trade.
 */
function resolveBestSetup(records: TradeRecord[]): BestSetup | null {
  if (records.length === 0) return null;

  // Candidate 1: high-RVOL subset (> 3x)
  const highRvol = records.filter(r => (r.relative_volume ?? 0) > 3);
  if (highRvol.length > 0) {
    const pnl = highRvol.reduce((sum, r) => sum + (r.net_pnl_dollars ?? 0), 0);
    const best = highRvol.reduce((acc, r) =>
      (r.net_pnl_dollars ?? 0) > (acc.net_pnl_dollars ?? 0) ? r : acc,
    );
    const label = best.origin === 'V2_PLAYMAKER' ? 'V2' : 'V1';
    return {
      description: `${label} avec RVOL > 3x (${best.symbol})`,
      totalPnlDollars: pnl,
      recordCount: highRvol.length,
      bestSymbol: best.symbol,
    };
  }

  // Candidate 2: best origin bucket by total PnL
  const v2Records = records.filter(r => r.origin === 'V2_PLAYMAKER');
  const v1Records = records.filter(r => r.origin === 'V1_CORE');
  const v2Pnl = v2Records.reduce((sum, r) => sum + (r.net_pnl_dollars ?? 0), 0);
  const v1Pnl = v1Records.reduce((sum, r) => sum + (r.net_pnl_dollars ?? 0), 0);

  const dominantRecords = v2Pnl >= v1Pnl ? v2Records : v1Records;
  const dominantLabel = v2Pnl >= v1Pnl ? 'V2' : 'V1';
  const dominantPnl = v2Pnl >= v1Pnl ? v2Pnl : v1Pnl;

  if (dominantRecords.length > 0) {
    const best = dominantRecords.reduce((acc, r) =>
      (r.net_pnl_dollars ?? 0) > (acc.net_pnl_dollars ?? 0) ? r : acc,
    );
    return {
      description: `${dominantLabel} (${best.symbol})`,
      totalPnlDollars: dominantPnl,
      recordCount: dominantRecords.length,
      bestSymbol: best.symbol,
    };
  }

  // Candidate 3: best individual trade
  const best = records.reduce((acc, r) =>
    (r.net_pnl_dollars ?? 0) > (acc.net_pnl_dollars ?? 0) ? r : acc,
  );
  const label = best.origin === 'V2_PLAYMAKER' ? 'V2' : 'V1';
  return {
    description: `${label} (${best.symbol})`,
    totalPnlDollars: best.net_pnl_dollars ?? 0,
    recordCount: 1,
    bestSymbol: best.symbol,
  };
}

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

/**
 * Reads today's closed records from the journal, computes KPIs and
 * sends the result as a Telegram report.
 *
 * Called automatically after the Hard Close (15:58 EST) at 16:05 EST.
 */
export async function runPostMortem(): Promise<void> {
  const journalPath = path.resolve(config.paths.journal);

  let allRecords: TradeRecord[] = [];
  try {
    const raw = await fs.readFile(journalPath, 'utf8');
    allRecords = JSON.parse(raw) as TradeRecord[];
  } catch {
    log.warn('Journal file absent or unreadable — skipping post-mortem');
    return;
  }

  // Filter to today's completed trades only
  const todayPrefix = new Date().toISOString().split('T')[0];
  const records = allRecords.filter(
    r => r.entry_time.startsWith(todayPrefix) && r.exit_time !== null,
  );

  if (records.length === 0) {
    log.info('No closed trades today — post-mortem skipped');
    await sendTelegramAlert(
      '📊 <b>[ANALYSE V5]</b> Aucun trade clôturé aujourd\'hui.',
    );
    return;
  }

  // Win Rate
  const winners = records.filter(r => (r.net_pnl_dollars ?? 0) > 0);
  const losers = records.filter(r => (r.net_pnl_dollars ?? 0) <= 0);
  const winRate = (winners.length / records.length) * 100;

  // Average Win / Average Loss (price-based %)
  const avgWinPct = average(winners.map(r => r.net_pnl_percentage ?? 0));
  const avgLossPct = Math.abs(average(losers.map(r => r.net_pnl_percentage ?? 0)));

  // Total net PnL
  const totalPnl = records.reduce((sum, r) => sum + (r.net_pnl_dollars ?? 0), 0);

  // Best MFE across all trades
  const bestMfe = Math.max(...records.map(r => r.mfe_percent ?? 0));

  // Best setup
  const bestSetup = resolveBestSetup(winners.length > 0 ? winners : records);
  const bestSetupDesc = bestSetup?.description ?? 'N/A';

  log.info(
    `Post-mortem — ${records.length} trade(s) | ` +
    `Win Rate: ${winRate.toFixed(0)}% (${winners.length}W/${losers.length}L) | ` +
    `Avg Win: +${avgWinPct.toFixed(2)}% | Avg Loss: -${avgLossPct.toFixed(2)}% | ` +
    `Total PnL: $${totalPnl.toFixed(2)} | Best MFE: +${bestMfe.toFixed(2)}% | ` +
    `Best setup: ${bestSetupDesc}`,
  );

  const message =
    `📊 <b>[ANALYSE V5]</b> Win Rate: ${winRate.toFixed(0)}% | ` +
    `Meilleur setup: ${bestSetupDesc}\n` +
    `📈 Avg Win: +${avgWinPct.toFixed(2)}% | Avg Loss: -${avgLossPct.toFixed(2)}%\n` +
    `💼 Trades: ${records.length} (${winners.length}W/${losers.length}L) | ` +
    `PnL net: $${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} | ` +
    `Best MFE: +${bestMfe.toFixed(2)}%`;

  await sendTelegramAlert(message);
}
