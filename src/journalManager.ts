import fs from 'fs/promises';
import path from 'path';
import config from './config';
import { createLogger } from './logger';
import type { TradeRecord, ExitReason, SignalOrigin, SpyTrend } from './types';

type ScaleOutTarget = 'target-5pct' | 'target-7pct';

const log = createLogger('JOURNAL');

const JOURNAL_PATH = path.resolve(config.paths.journal);

// Open trade records — symbol → record in progress
const openRecords = new Map<string, TradeRecord>();

// Last market price observed for each open position (used as fallback exit price)
const lastKnownPrices = new Map<string, number>();

// Completed records accumulated during this session
const closedRecords: TradeRecord[] = [];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface OpenTradeParams {
  origin: SignalOrigin;
  alpha_vs_spy: number | null;
  gap_percentage: number | null;
  relative_volume: number | null;
  entry_price: number;
  qty: number;
  vwap_at_entry: number;
  ema9_at_entry: number | null;
  sma20_at_entry: number | null;
  spy_trend_5m: SpyTrend;
}

/**
 * Called immediately after a bracket order is confirmed.
 * Initialises the TradeRecord with all available pre-trade and entry context.
 */
export function openTrade(symbol: string, params: OpenTradeParams): void {
  if (openRecords.has(symbol)) {
    log.warn(`${symbol}: openTrade called but record already exists — overwriting`);
  }

  const distance_to_sma20_percent =
    params.sma20_at_entry !== null
      ? ((params.entry_price - params.sma20_at_entry) / params.sma20_at_entry) * 100
      : null;

  const record: TradeRecord = {
    symbol,
    origin: params.origin,
    alpha_vs_spy: params.alpha_vs_spy,
    gap_percentage: params.gap_percentage,
    relative_volume: params.relative_volume,
    entry_time: new Date().toISOString(),
    entry_price: params.entry_price,
    qty: params.qty,
    vwap_at_entry: params.vwap_at_entry,
    ema9_at_entry: params.ema9_at_entry,
    sma20_at_entry: params.sma20_at_entry,
    distance_to_sma20_percent,
    spy_trend_5m: params.spy_trend_5m,
    scale_out_price: null,
    scale_out_qty: null,
    scale_out_reason: null,
    exit_time: null,
    exit_price: null,
    exit_reason: null,
    net_pnl_dollars: null,
    net_pnl_percentage: null,
    mfe_percent: null,
    mae_percent: null,
  };

  openRecords.set(symbol, record);
  lastKnownPrices.set(symbol, params.entry_price);
  log.info(`${symbol}: trade record opened at $${params.entry_price.toFixed(2)}`);
}

/**
 * Called on every 1-min bar close for open positions.
 * Tracks Maximum Favorable Excursion (MFE) and Maximum Adverse Excursion (MAE).
 */
export function updateExcursions(symbol: string, currentPrice: number): void {
  const record = openRecords.get(symbol);
  if (!record) return;

  lastKnownPrices.set(symbol, currentPrice);

  const excursionPct = ((currentPrice - record.entry_price) / record.entry_price) * 100;

  if (record.mfe_percent === null || excursionPct > record.mfe_percent) {
    record.mfe_percent = excursionPct;
  }
  if (record.mae_percent === null || excursionPct < record.mae_percent) {
    record.mae_percent = excursionPct;
  }
}

/**
 * Records a partial scale-out (50% of the position sold at the take-profit target).
 * The TradeRecord stays open — it will be closed when the remaining shares exit
 * (trailing stop, EOD sweep, or hard close).
 */
export function recordScaleOut(
  symbol: string,
  reason: ScaleOutTarget,
  scaleOutPrice: number,
  scaleOutQty: number,
): void {
  const record = openRecords.get(symbol);
  if (!record) return;

  record.scale_out_price = scaleOutPrice;
  record.scale_out_qty = scaleOutQty;
  record.scale_out_reason = reason;
  lastKnownPrices.set(symbol, scaleOutPrice);

  log.info(
    `${symbol}: scale-out recorded — reason:${reason} ` +
    `price:$${scaleOutPrice.toFixed(2)} qty:${scaleOutQty} ` +
    `(record stays open for trailing leg)`,
  );
}

/**
 * Closes a trade record.
 * If exitPrice is omitted, the last price observed via updateExcursions is used.
 * When a scale-out was previously recorded, computes a dollar-weighted PnL
 * across both legs: (50% at scale_out_price) + (remainder at exit_price).
 * Safe to call on a symbol with no open record — silently ignored.
 */
export function closeTrade(
  symbol: string,
  exitReason: ExitReason,
  exitPrice?: number,
): void {
  const record = openRecords.get(symbol);
  if (!record) return;

  const price = exitPrice ?? lastKnownPrices.get(symbol) ?? record.entry_price;

  // Final excursion update at the exit price
  updateExcursions(symbol, price);

  // Dollar-weighted PnL: accounts for partial scale-out when present
  let net_pnl_dollars: number;
  let net_pnl_percentage: number;

  if (record.scale_out_price !== null && record.scale_out_qty !== null) {
    const soldQty = record.scale_out_qty;
    const remainingQty = record.qty - soldQty;
    const pnlLeg1 = (record.scale_out_price - record.entry_price) * soldQty;
    const pnlLeg2 = (price - record.entry_price) * remainingQty;
    net_pnl_dollars = pnlLeg1 + pnlLeg2;
    // Return on the full notional deployed (entry_price × total qty)
    net_pnl_percentage = (net_pnl_dollars / (record.entry_price * record.qty)) * 100;
  } else {
    net_pnl_dollars = (price - record.entry_price) * record.qty;
    net_pnl_percentage = ((price - record.entry_price) / record.entry_price) * 100;
  }

  record.exit_time = new Date().toISOString();
  record.exit_price = price;
  record.exit_reason = exitReason;
  record.net_pnl_dollars = net_pnl_dollars;
  record.net_pnl_percentage = net_pnl_percentage;

  openRecords.delete(symbol);
  lastKnownPrices.delete(symbol);
  closedRecords.push(record);

  const scaleOutLabel = record.scale_out_price !== null
    ? ` scale-out:$${record.scale_out_price.toFixed(2)} +`
    : '';
  log.info(
    `${symbol}: trade closed — reason:${exitReason}${scaleOutLabel} ` +
    `finalPrice:$${price.toFixed(2)} PnL:${net_pnl_percentage.toFixed(2)}% ` +
    `($${net_pnl_dollars.toFixed(2)}) | MFE:${(record.mfe_percent ?? 0).toFixed(2)}% ` +
    `MAE:${(record.mae_percent ?? 0).toFixed(2)}%`,
  );

  saveJournal().catch((err: unknown) => {
    log.warn(`Journal auto-save failed: ${String(err)}`);
  });
}

/**
 * Closes all remaining open records with a bulk exit reason.
 * Used for hard close and circuit breaker liquidations where individual
 * sell prices are not tracked per-symbol.
 */
export function closeAllOpenTrades(exitReason: ExitReason): void {
  const symbols = [...openRecords.keys()];
  if (symbols.length === 0) return;
  log.info(`Bulk close (${exitReason}) — ${symbols.length} open record(s)`);
  for (const symbol of symbols) {
    closeTrade(symbol, exitReason);
  }
}

/**
 * Appends today's closed records to the persistent journal file.
 * Records already present (matched on symbol + entry_time) are not duplicated.
 */
export async function saveJournal(): Promise<void> {
  if (closedRecords.length === 0) return;

  try {
    await fs.mkdir(path.dirname(JOURNAL_PATH), { recursive: true });

    let existing: TradeRecord[] = [];
    try {
      const raw = await fs.readFile(JOURNAL_PATH, 'utf8');
      existing = JSON.parse(raw) as TradeRecord[];
    } catch {
      // File absent or corrupted — start fresh
    }

    const existingKeys = new Set(existing.map(r => `${r.symbol}:${r.entry_time}`));
    const toAdd = closedRecords.filter(r => !existingKeys.has(`${r.symbol}:${r.entry_time}`));

    if (toAdd.length === 0) return;

    await fs.writeFile(
      JOURNAL_PATH,
      JSON.stringify([...existing, ...toAdd], null, 2),
    );
    log.info(
      `Journal saved — ${toAdd.length} new record(s), ` +
      `${existing.length + toAdd.length} total`,
    );
  } catch (err) {
    log.error(`Journal save failed: ${String(err)}`);
  }
}

export function getClosedRecords(): TradeRecord[] {
  return [...closedRecords];
}

/**
 * Resets in-memory state at daily rollover (20:00 EST).
 * Does NOT delete the journal file — records are cumulative.
 */
export function reset(): void {
  openRecords.clear();
  lastKnownPrices.clear();
  closedRecords.length = 0;
  log.info('Journal state reset for new session');
}
