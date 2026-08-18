/**
 * Journal replay backtest.
 *
 * Re-scores the historical trade journal under the current risk parameters to
 * estimate the corrected P&L. This is an approximation, not a tick-level
 * simulation: the journal exposes entry/exit prices, MFE/MAE and the realized
 * P&L, but not the full intrabar path. The model therefore applies:
 *
 *   1. Entry filter  — drop trades entered more than VWAP_ENTRY_CAP_PCT above the
 *                      session VWAP (the dominant historical loss driver; already
 *                      enforced live by the FeedbackEngine adaptive cap).
 *   2. Stop ceiling  — when a trade's MAE breached maxStopCeilingPct, assume it
 *                      would have been stopped out at the ceiling instead of its
 *                      deeper realized low. Conservative: it can turn a recovered
 *                      winner into a small loss, never the reverse.
 *   3. Sizing        — recompute quantity from the new slot share (concentration)
 *                      and the Satellite size multiplier.
 *
 * The hard gap cap is reported separately: the journal's gap_percentage field is
 * inconsistently scaled across strategy versions, so it is not used to drop
 * trades in the headline figure.
 *
 * Usage: tsx scripts/backtestJournal.ts [path/to/journal.json]
 */
import fs from 'fs';
import path from 'path';
import config, { getSlotCapitalShare } from '../src/config';
import type { TradeRecord } from '../src/types';

// Slot share the journal was generated under (MAX_POSITIONS=5 → 20% per slot).
const BASELINE_SLOT_SHARE = 0.20;
// Entry cap mirrored from the FeedbackEngine default (VWAP_DIST_DEFAULT_CAP).
const VWAP_ENTRY_CAP_PCT = 3.0;

interface ReplayRow {
  symbol: string;
  origin: TradeRecord['origin'];
  vwapDistPct: number;
  blocked: boolean;
  stopCapped: boolean;
  originalPnl: number;
  adjustedPnl: number;
}

function isClosed(r: TradeRecord): boolean {
  return r.exit_time !== null && r.net_pnl_dollars !== null;
}

function vwapDistancePct(r: TradeRecord): number {
  if (r.vwap_at_entry <= 0) return 0;
  return ((r.entry_price - r.vwap_at_entry) / r.vwap_at_entry) * 100;
}

function normalizedGapPct(r: TradeRecord): number | null {
  if (r.gap_percentage === null) return null;
  return r.gap_percentage <= 1 ? r.gap_percentage * 100 : r.gap_percentage;
}

function replayTrade(r: TradeRecord): ReplayRow {
  const originalPnl = r.net_pnl_dollars ?? 0;
  const dist = vwapDistancePct(r);
  const tier = r.origin === 'V2_PLAYMAKER' ? 'satellite' : 'core';

  if (dist > VWAP_ENTRY_CAP_PCT) {
    return {
      symbol: r.symbol,
      origin: r.origin,
      vwapDistPct: dist,
      blocked: true,
      stopCapped: false,
      originalPnl,
      adjustedPnl: 0,
    };
  }

  const ceilingPct = config.risk.maxStopCeilingPct * 100;
  const realizedPct = r.net_pnl_percentage ?? 0;
  const mae = r.mae_percent;
  const stopCapped = mae !== null && mae < -ceilingPct;
  const effectivePct = stopCapped ? -ceilingPct : realizedPct;

  const tierMultiplier = tier === 'satellite' ? config.risk.satelliteSizeMultiplier : 1;
  const qtyFactor = (getSlotCapitalShare() / BASELINE_SLOT_SHARE) * tierMultiplier;
  const newQty = Math.round(r.qty * qtyFactor);
  const adjustedPnl = (effectivePct / 100) * r.entry_price * newQty;

  return {
    symbol: r.symbol,
    origin: r.origin,
    vwapDistPct: dist,
    blocked: false,
    stopCapped,
    originalPnl,
    adjustedPnl,
  };
}

function money(n: number): string {
  const sign = n < 0 ? '-' : '+';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function main(): void {
  const journalPath = path.resolve(
    process.argv[2] ?? path.join(__dirname, '..', 'data', 'journal.sample.json'),
  );

  const raw = fs.readFileSync(journalPath, 'utf8');
  const records = (JSON.parse(raw) as TradeRecord[]).filter(isClosed);

  const rows = records.map(replayTrade);

  const originalTotal = rows.reduce((s, r) => s + r.originalPnl, 0);
  const adjustedTotal = rows.reduce((s, r) => s + r.adjustedPnl, 0);
  const blocked = rows.filter(r => r.blocked);
  const capped = rows.filter(r => r.stopCapped);
  const gapWouldBlock = records.filter(r => {
    const g = normalizedGapPct(r);
    return g !== null && g > config.entry.maxEntryGapPct * 100;
  });

  console.log('\n=== JOURNAL REPLAY BACKTEST ===');
  console.log(`Source        : ${journalPath}`);
  console.log(`Closed trades : ${records.length}`);
  console.log(
    `Parameters    : slot ${(getSlotCapitalShare() * 100).toFixed(1)}% ` +
    `(was ${(BASELINE_SLOT_SHARE * 100).toFixed(0)}%) | ` +
    `satellite ×${config.risk.satelliteSizeMultiplier} | ` +
    `stop ceiling ${(config.risk.maxStopCeilingPct * 100).toFixed(1)}% | ` +
    `VWAP entry cap ${VWAP_ENTRY_CAP_PCT.toFixed(1)}%`,
  );

  console.log('\n--- Per-trade detail (sorted by original P&L) ---');
  const sorted = [...rows].sort((a, b) => a.originalPnl - b.originalPnl);
  for (const r of sorted) {
    const tag = r.blocked
      ? 'BLOCKED (vwap)'
      : r.stopCapped
        ? 'stop-capped'
        : '';
    console.log(
      `${r.symbol.padEnd(6)} ${r.origin === 'V2_PLAYMAKER' ? 'V2' : 'V1'} | ` +
      `vwap ${r.vwapDistPct.toFixed(1).padStart(6)}% | ` +
      `orig ${money(r.originalPnl).padStart(11)} -> adj ${money(r.adjustedPnl).padStart(11)} ` +
      `${tag}`,
    );
  }

  console.log('\n--- Summary ---');
  console.log(`Original net P&L : ${money(originalTotal)}`);
  console.log(`Adjusted net P&L : ${money(adjustedTotal)}`);
  console.log(`Delta            : ${money(adjustedTotal - originalTotal)}`);
  console.log(`Trades blocked by VWAP cap : ${blocked.length}`);
  console.log(`Trades capped by stop ceiling : ${capped.length}`);
  console.log(
    `(Informational) hard gap cap would additionally flag : ${gapWouldBlock.length} ` +
    `trade(s) — journal gap field scaling is inconsistent, excluded from headline.`,
  );
  console.log('');
}

main();
