import fs from 'fs/promises';
import path from 'path';
import config from './config';
import { createLogger } from './logger';
import { getESTDate } from './utils';
import { sendTelegramAlert } from './notificationManager';
import { alertInfo } from './notifier';
import {
  computeRollingExpectancy,
  formatExpectancyLine,
  normalizeTradeRecords,
} from './expectancy';
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

function sessionDatePrefixEST(): string {
  const est = getESTDate();
  const y = est.getFullYear();
  const m = String(est.getMonth() + 1).padStart(2, '0');
  const d = String(est.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

/**
 * Reads closed journal records, computes KPIs + expectancy in R, and notifies.
 * Called automatically after the Hard Close (15:58 EST) at 16:05 EST.
 */
export async function runPostMortem(): Promise<void> {
  const journalPath = path.resolve(config.paths.journal);

  let allRecords: TradeRecord[] = [];
  try {
    const raw = await fs.readFile(journalPath, 'utf8');
    allRecords = normalizeTradeRecords(JSON.parse(raw) as TradeRecord[]);
  } catch {
    log.warn('Journal file absent or unreadable — skipping post-mortem');
    return;
  }

  const todayESTPrefix = sessionDatePrefixEST();

  const records = allRecords.filter(
    r => r.entry_time.startsWith(todayESTPrefix) && r.exit_time !== null,
  );

  if (records.length === 0) {
    log.info('No closed trades today — post-mortem skipped');
    return;
  }

  // Win Rate (dollar PnL — unchanged legacy KPI)
  const winners = records.filter(r => (r.net_pnl_dollars ?? 0) > 0);
  const losers = records.filter(r => (r.net_pnl_dollars ?? 0) <= 0);
  const winRate = (winners.length / records.length) * 100;

  const avgWinPct = average(winners.map(r => r.net_pnl_percentage ?? 0));
  const avgLossPct = Math.abs(average(losers.map(r => r.net_pnl_percentage ?? 0)));
  const totalPnl = records.reduce((sum, r) => sum + (r.net_pnl_dollars ?? 0), 0);
  const bestMfe = Math.max(...records.map(r => r.mfe_percent ?? 0));

  const bestSetup = resolveBestSetup(winners.length > 0 ? winners : records);
  const bestSetupDesc = bestSetup?.description ?? 'N/A';

  const rolling = computeRollingExpectancy(allRecords, todayESTPrefix);
  const sessionE = rolling.session;

  log.info(
    `Post-mortem — ${records.length} trade(s) | ` +
    `Win Rate: ${winRate.toFixed(0)}% (${winners.length}W/${losers.length}L) | ` +
    `Avg Win: +${avgWinPct.toFixed(2)}% | Avg Loss: -${avgLossPct.toFixed(2)}% | ` +
    `Total PnL: $${totalPnl.toFixed(2)} | Best MFE: +${bestMfe.toFixed(2)}% | ` +
    `Best setup: ${bestSetupDesc}`,
  );
  log.info(formatExpectancyLine('Expectancy session', sessionE));
  log.info(formatExpectancyLine('Expectancy last20', rolling.last20));
  log.info(formatExpectancyLine('Expectancy last50', rolling.last50));

  const eRLabel = sessionE.n > 0
    ? `E_R ${sessionE.eR >= 0 ? '+' : ''}${sessionE.eR.toFixed(2)}R [${sessionE.scenario ?? 'N/A'}]`
    : 'E_R N/A (no risk_$ on closed trades)';

  const message =
    `<b>[ANALYSE V7]</b> Win Rate: ${winRate.toFixed(0)}% | ` +
    `Meilleur setup: ${bestSetupDesc}\n` +
    `Avg Win: +${avgWinPct.toFixed(2)}% | Avg Loss: -${avgLossPct.toFixed(2)}%\n` +
    `Trades: ${records.length} (${winners.length}W/${losers.length}L) | ` +
    `PnL net: $${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} | ` +
    `Best MFE: +${bestMfe.toFixed(2)}%\n` +
    `${eRLabel}`;

  await sendTelegramAlert(message);

  await alertInfo(
    'Expectancy post-mortem',
    `${records.length} closed trade(s) today — ${eRLabel}`,
    [
      {
        name: 'Session E_R',
        value: sessionE.n > 0
          ? `${sessionE.eR >= 0 ? '+' : ''}${sessionE.eR.toFixed(2)}R`
          : 'N/A',
        inline: true,
      },
      {
        name: 'Scenario',
        value: sessionE.scenario ?? 'N/A',
        inline: true,
      },
      {
        name: 'WR (session R)',
        value: sessionE.n > 0 ? `${(sessionE.winRate * 100).toFixed(1)}%` : 'N/A',
        inline: true,
      },
      {
        name: 'Last 20 E_R',
        value: rolling.last20.n > 0
          ? `${rolling.last20.eR >= 0 ? '+' : ''}${rolling.last20.eR.toFixed(2)}R`
          : 'N/A',
        inline: true,
      },
      {
        name: 'Last 50 E_R',
        value: rolling.last50.n > 0
          ? `${rolling.last50.eR >= 0 ? '+' : ''}${rolling.last50.eR.toFixed(2)}R`
          : 'N/A',
        inline: true,
      },
      {
        name: 'Total PnL $',
        value: `$${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}`,
        inline: true,
      },
    ],
  );
}
