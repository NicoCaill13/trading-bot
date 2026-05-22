import { ATR } from 'technicalindicators';
import alpaca from './alpacaClient';
import config, { getSlotCapitalShare } from './config';
import * as trader from './trader';
import * as journalManager from './journalManager';
import { createLogger } from './logger';
import { toErrorMessage } from './utils';
import { sendTelegramAlert, formatExitAlert } from './notificationManager';
import type {
  PortfolioAllocation,
  PortfolioOrigin,
  PositionSizeResult,
  SignalTier,
} from './types';
import type { AlpacaPosition } from '@alpacahq/alpaca-trade-api';

const log = createLogger('RISK_MANAGER');

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

// Symbols that already triggered scale-out (prevents double execution)
const scaledOutPositions = new Set<string>();

// Prevents duplicate exit alerts when broker-side stops fill between bar events
const externalExitNotified = new Set<string>();

// Starting reference for the daily circuit breaker
let startOfDayEquity: number | null = null;
let circuitBreakerTriggered = false;

// ---------------------------------------------------------------------------
// 1. Session initialization
// ---------------------------------------------------------------------------

export function initDailyBaseline(equity: number): void {
  startOfDayEquity = equity;
  circuitBreakerTriggered = false;
  scaledOutPositions.clear();
  externalExitNotified.clear();
  log.info(`Daily baseline initialized at $${equity.toFixed(2)}`);
}

// Exposed to let index.ts check the flag synchronously BEFORE tradingHalted is set
// — fixes the race condition with the debounce timer
export function isCircuitBreakerTriggered(): boolean {
  return circuitBreakerTriggered;
}

/**
 * Returns true when the position was closed by a broker-side order
 * (stop-loss or trailing stop fill) without a direct placeSellOrder call.
 * Used by index.ts to close the corresponding journal record.
 */
export function wasExternallyExited(symbol: string): boolean {
  return externalExitNotified.has(symbol);
}

/**
 * Returns true when the symbol already had a 50% scale-out executed.
 * Lets index.ts distinguish trailing-stop exit from initial stop-loss exit.
 */
export function wasScaledOut(symbol: string): boolean {
  return scaledOutPositions.has(symbol);
}

/**
 * Restores scale-out state from disk persistence or broker reconciliation.
 * Called at startup when a previous session is detected (crash recovery).
 */
export function markScaledOut(symbols: string[]): void {
  for (const symbol of symbols) {
    scaledOutPositions.add(symbol);
  }
  if (symbols.length > 0) {
    log.info(
      `Reconciliation: ${symbols.length} symbol(s) marked as scaled-out ` +
      `(${symbols.join(', ')})`,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Slot-based capital allocation (CTPO: N equal slots × 20% equity each)
// ---------------------------------------------------------------------------

function resolvePositionMarketValue(pos: AlpacaPosition): number {
  const qty = parseInt(pos.qty, 10);
  const price = parseFloat(pos.current_price);
  return Math.abs(qty) * price;
}

/**
 * CTPO equiparity: each of maxPositions slots owns an immutable share of equity
 * (default 5 × 20%). Tier (Core / Satellite) does not shrink the slot envelope —
 * a Satellite backfill into a Core time-decay slot still sizes at the full 20%.
 */
export async function getPortfolioAllocation(
  origin: PortfolioOrigin,
  _positionTiers: Map<string, SignalTier>,
): Promise<PortfolioAllocation> {
  const totalCapital = await trader.getAccountEquity();
  const slotShare = getSlotCapitalShare();
  const positionCapital = totalCapital * slotShare;

  const positions = await trader.getOpenPositions();
  let deployed = 0;

  for (const pos of positions) {
    deployed += resolvePositionMarketValue(pos);
  }

  const slotsUsed = positions.length;
  const slotsAvailable = config.risk.maxPositions - slotsUsed;
  const canOpen = slotsAvailable > 0;

  return {
    origin,
    totalCapital,
    maxCapital: positionCapital,
    deployed,
    available: canOpen ? positionCapital : 0,
    canOpen,
  };
}

// ---------------------------------------------------------------------------
// 3. Coherent ATR sizing + hard-stop floor (full slot envelope per trade)
// ---------------------------------------------------------------------------

/**
 * Computes position size and stop level coherently (CTPO slot equiparity).
 *
 * positionCapital = totalEquity × (1 / maxPositions)   [e.g. $20k on $100k, 5 slots]
 * riskBudget      = positionCapital × riskPerTradePct [1% of slot → ATR distance]
 * stopDistance    = max(ATR × atrStopMultiplier, entryPrice × hardStopFloorPct)
 * qty             = floor(riskBudget / stopDistance), capped to positionCapital notional
 *
 * Core and Satellite (including V2 backfill into a Core time-decay slot) use the
 * same 20% global slot envelope — tier is observability only for sizing.
 */
export async function computePositionSize(
  symbol: string,
  entryPrice: number,
  _totalCapital: number,
  tier: SignalTier = 'core',
  positionTiers: Map<string, SignalTier> = new Map(),
): Promise<PositionSizeResult> {
  const period = config.indicators.atrPeriod;
  const needed = period + 5;

  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - Math.ceil(needed * 1.6) + 1);

  const highs: number[] = [];
  const lows: number[] = [];
  const closes: number[] = [];

  const iter = alpaca.getBarsV2(symbol, {
    start: start.toISOString().split('T')[0],
    end: end.toISOString().split('T')[0],
    timeframe: '1Day',
    feed: 'iex',
  });

  for await (const bar of iter) {
    highs.push(bar.HighPrice);
    lows.push(bar.LowPrice);
    closes.push(bar.ClosePrice);
  }

  if (highs.length < period + 1) {
    throw new Error(
      `${symbol}: insufficient history for ATR (${highs.length} bars)`,
    );
  }

  const atrValues = ATR.calculate({ period, high: highs, low: lows, close: closes });
  const atr = atrValues[atrValues.length - 1];

  if (!atr || atr <= 0) {
    throw new Error(`${symbol}: invalid ATR value (${atr})`);
  }

  // Stop coherent with sizing — hard-stop acts as safety floor
  const atrStopDistance = atr * config.risk.atrStopMultiplier;
  const hardFloorDistance = entryPrice * config.risk.hardStopFloorPct;
  const stopDistance = Math.max(atrStopDistance, hardFloorDistance);

  const allocation = await getPortfolioAllocation(tier, positionTiers);
  if (!allocation.canOpen) {
    throw new Error(
      `${symbol}: no slots available — ${config.risk.maxPositions} max, ` +
      `deployed $${allocation.deployed.toFixed(2)} / $${allocation.totalCapital.toFixed(2)} equity`,
    );
  }

  const totalEquity = allocation.totalCapital;
  const positionCapital = totalEquity * getSlotCapitalShare();
  const riskBudget = positionCapital * config.risk.riskPerTradePct;
  const rawQty = riskBudget / stopDistance;
  const qty = Math.max(1, Math.floor(rawQty));

  const maxPositionValue = positionCapital;
  const cappedQty = Math.min(qty, Math.floor(maxPositionValue / entryPrice));

  if (cappedQty < 1) {
    throw new Error(
      `${symbol}: slot envelope insufficient — ` +
      `positionCapital $${positionCapital.toFixed(2)} for ~$${entryPrice.toFixed(2)}/share`,
    );
  }

  const stopLossPrice = entryPrice - stopDistance;

  log.info(
    `${symbol} sizing [${tier}] — ATR:${atr.toFixed(4)} | ` +
    `slot ${(getSlotCapitalShare() * 100).toFixed(0)}% equity ($${positionCapital.toFixed(0)}) | ` +
    `risk ${(config.risk.riskPerTradePct * 100).toFixed(1)}% of slot ($${riskBudget.toFixed(0)}) | ` +
    `envelope $${positionCapital.toFixed(0)} / $${totalEquity.toFixed(0)} equity | ` +
    `stopDist:$${stopDistance.toFixed(4)} | qty:${cappedQty} | stopLoss:$${stopLossPrice.toFixed(2)}`,
  );

  return { qty: cappedQty, stopLossPrice, atr };
}

// ---------------------------------------------------------------------------
// 4. Daily circuit breaker (+1% net PnL)
// ---------------------------------------------------------------------------

/**
 * Checks whether the daily target has been reached.
 * If yes: cancels all orders, liquidates all positions, returns true.
 * Should be called on each bar event.
 */
export async function checkCircuitBreaker(currentEquity: number): Promise<boolean> {
  if (circuitBreakerTriggered || startOfDayEquity === null) return false;

  const dailyPnlPct = (currentEquity - startOfDayEquity) / startOfDayEquity;

  if (dailyPnlPct >= config.risk.dailyProfitTargetPct) {
    circuitBreakerTriggered = true;
    log.warn(
      `*** DAILY CIRCUIT BREAKER *** ` +
      `Net PnL +${(dailyPnlPct * 100).toFixed(2)}% — ` +
      `target ${(config.risk.dailyProfitTargetPct * 100).toFixed(1)}% reached`,
    );
    log.warn('Immediate liquidation of all positions...');
    journalManager.closeAllOpenTrades('circuit-breaker');
    await trader.liquidateAll('circuit-breaker-daily-target');
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 5. Active position management (scale-out +3% + trailing stop)
// ---------------------------------------------------------------------------

/**
 * Called on each 1-min WS bar close for held symbols (index.ts — UT1m loop).
 *
 * Tier-specific take-profit targets:
 *   - V1_CORE  (tier 'core')      → +5%  triggers a 50% partial exit
 *   - V2_PLAYMAKER (tier 'satellite') → +7%  triggers a 50% partial exit
 *
 * After the target is hit:
 *   - Cancels the original stop-loss (placed at -ATR distance below entry).
 *   - Sells Math.floor(qty / 2) shares at market (no fractional shares).
 *   - Places a trailing stop on the remainder with a floor above break-even.
 *
 * @param tier - from enteredByTier map in index.ts ('core' | 'satellite')
 */
export async function handlePositionUpdate(
  symbol: string,
  currentPrice: number,
  tier: SignalTier = 'core',
): Promise<void> {
  if (scaledOutPositions.has(symbol)) return;

  let position;
  try {
    position = await alpaca.getPosition(symbol);
  } catch {
    if (!externalExitNotified.has(symbol)) {
      externalExitNotified.add(symbol);
      void sendTelegramAlert(
        formatExitAlert(symbol, 'Stop Loss / Trailing Stop'),
      );
    }
    return;
  }

  const entryPrice = parseFloat(position.avg_entry_price);
  const totalQty = parseInt(position.qty, 10);
  const unrealizedPct = (currentPrice - entryPrice) / entryPrice;

  const targetPct = tier === 'satellite'
    ? config.risk.scaleOutTargetPctSatellite
    : config.risk.scaleOutTargetPctCore;

  const tierLabel: 'Core' | 'Satellite' = tier === 'satellite' ? 'Satellite' : 'Core';

  if (unrealizedPct >= targetPct) {
    const sellQty = Math.floor(totalQty / 2);
    if (sellQty < 1) return;

    try {
      await trader.executeBreakEvenScaleOut(symbol, sellQty, entryPrice, targetPct, tierLabel);
      scaledOutPositions.add(symbol);

      // Journal: mark the partial scale-out without closing the record.
      // The record stays alive for the trailing-stop leg; it will be closed
      // when the remaining shares exit (wasExternallyExited in index.ts, or
      // closeAllOpenTrades at hard-close / circuit-breaker).
      const scaleOutReason = tier === 'satellite' ? 'target-7pct' as const : 'target-5pct' as const;
      const scaleOutPrice = parseFloat((entryPrice * (1 + targetPct)).toFixed(2));
      journalManager.recordScaleOut(symbol, scaleOutReason, scaleOutPrice, sellQty);
    } catch (err) {
      log.error(`${symbol}: break-even scale-out failed — ${toErrorMessage(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 6. EOD sweep 15:45 EST (tight choke)
// ---------------------------------------------------------------------------

export interface SessionDataEntry {
  vwap: number;
  high: number;
  lastBarLow: number;
}

/**
 * Logic at 15:45:
 *   - Liquidates any position where currentPrice < VWAP OR PnL < 0
 *   - For survivors: replaces trailing stop with an ultra-tight one (0.5%)
 *   - Does NOT call cancelAllOrders() globally — bracket stop-losses stay active
 *     until each symbol is individually processed (prevents unprotected exposure window)
 */
export async function runEodSweep(
  sessionData: Map<string, SessionDataEntry>,
): Promise<void> {
  log.info('Starting EOD sweep 15:45 EST...');

  const positions = await alpaca.getPositions();

  if (positions.length === 0) {
    log.info('No open positions — sweep done');
    return;
  }

  const totalPnl = positions.reduce((sum, p) => sum + parseFloat(p.unrealized_pl), 0);
  log.info(`Total unrealized PnL: $${totalPnl.toFixed(2)}`);

  for (const pos of positions) {
    const symbol = pos.symbol;
    const currentPrice = parseFloat(pos.current_price);
    const positionPnl = parseFloat(pos.unrealized_pl);
    const qty = parseInt(pos.qty, 10);
    const data = sessionData.get(symbol);

    if (!data) {
      log.warn(`${symbol}: no session data — conservative liquidation`);
      journalManager.closeTrade(symbol, 'eod-liquidation', currentPrice);
      try {
        await trader.cancelOrdersForSymbol(symbol);
        await new Promise(r => setTimeout(r, 300));
        await trader.placeSellOrder(symbol, qty, 'eod-no-session-data');
      } catch (err) {
        log.error(`EOD sweep: ${symbol} (no-data) sell failed — ${toErrorMessage(err)}`);
      }
      continue;
    }

    const isBelowVwap = currentPrice < data.vwap;
    const isInLoss = positionPnl < 0;

    // Each symbol is isolated: one failure must not abort the remaining positions
    try {
      if (isBelowVwap || isInLoss) {
        log.info(
          `${symbol}: ` +
          `${isBelowVwap ? `price $${currentPrice.toFixed(2)} below VWAP $${data.vwap.toFixed(2)}` : ''} ` +
          `${isInLoss ? `negative PnL $${positionPnl.toFixed(2)}` : ''} — liquidating`,
        );
        // Cancel symbol's protection orders BEFORE selling (avoids accidental short).
        // 300 ms delay lets Alpaca propagate the cancellation before the market sell arrives.
        await trader.cancelOrdersForSymbol(symbol);
        await new Promise(r => setTimeout(r, 300));
        await trader.placeSellOrder(symbol, qty, 'eod-liquidation');
      } else {
        // Winning position above VWAP: tighten trailing to 0.5%
        log.info(
          `${symbol}: winning position $${currentPrice.toFixed(2)} ` +
          `(VWAP $${data.vwap.toFixed(2)}, PnL +$${positionPnl.toFixed(2)}) — ` +
          `ultra-tight trailing ${(config.risk.eodTightTrailPct * 100).toFixed(1)}%`,
        );
        await trader.replaceWithTrailingStop(symbol, config.risk.eodTightTrailPct);
      }
    } catch (err) {
      log.error(`EOD sweep: ${symbol} failed — ${toErrorMessage(err)}`);
    }
  }

  log.info('EOD sweep 15:45 done');
}

// ---------------------------------------------------------------------------
// 7. Hard close 15:58 EST
// ---------------------------------------------------------------------------

/**
 * Final cutoff: unconditionally liquidates all remaining positions.
 */
export async function runHardClose(): Promise<void> {
  log.warn('*** HARD CLOSE 15:58 EST *** Unconditional full liquidation');
  journalManager.closeAllOpenTrades('hard-close');
  await trader.liquidateAll('hard-close-15h58');
  log.info('Hard close done');
}
