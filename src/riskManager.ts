import { ATR } from 'technicalindicators';
import alpaca from './alpacaClient';
import config from './config';
import * as trader from './trader';
import { createLogger } from './logger';
import type { PositionSizeResult } from './types';

const log = createLogger('RISK_MANAGER');

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

// Symbols that already triggered scale-out (prevents double execution)
const scaledOutPositions = new Set<string>();

// Starting reference for the daily circuit breaker
let startOfDayEquity: number | null = null;
let circuitBreakerTriggered         = false;

// ---------------------------------------------------------------------------
// 1. Session initialization
// ---------------------------------------------------------------------------

export function initDailyBaseline(equity: number): void {
  startOfDayEquity        = equity;
  circuitBreakerTriggered = false;
  scaledOutPositions.clear();
  log.info(`Daily baseline initialized at $${equity.toFixed(2)}`);
}

// Exposed to let index.ts check the flag synchronously BEFORE tradingHalted is set
// — fixes the race condition with the debounce timer
export function isCircuitBreakerTriggered(): boolean {
  return circuitBreakerTriggered;
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
// 2. Coherent ATR sizing + hard-stop floor
// ---------------------------------------------------------------------------

/**
 * Computes position size and stop level coherently.
 *
 * stopDistance = max(ATR × atrStopMultiplier, entryPrice × hardStopFloorPct)
 * qty          = floor( (capital × riskPerTradePct) / stopDistance )
 * qty          = min(qty, floor(capital × maxPositionPct / entryPrice))  [value cap]
 *
 * This guarantees identical real monetary risk per trade regardless of
 * the instrument's volatility.
 */
export async function computePositionSize(
  symbol: string,
  entryPrice: number,
  totalCapital: number,
): Promise<PositionSizeResult> {
  const period = config.indicators.atrPeriod;
  const needed = period + 5;

  const end   = new Date();
  const start = new Date();
  start.setDate(start.getDate() - Math.ceil(needed * 1.6) + 1);

  const highs:  number[] = [];
  const lows:   number[] = [];
  const closes: number[] = [];

  const iter = alpaca.getBarsV2(symbol, {
    start:     start.toISOString().split('T')[0],
    end:       end.toISOString().split('T')[0],
    timeframe: '1Day',
    feed:      'iex',
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
  const atr       = atrValues[atrValues.length - 1];

  if (!atr || atr <= 0) {
    throw new Error(`${symbol}: invalid ATR value (${atr})`);
  }

  // Stop coherent with sizing — hard-stop acts as safety floor
  const atrStopDistance   = atr * config.risk.atrStopMultiplier;
  const hardFloorDistance = entryPrice * config.risk.hardStopFloorPct;
  const stopDistance      = Math.max(atrStopDistance, hardFloorDistance);

  // Quantity calibrated to target monetary risk per trade
  const riskBudget = totalCapital * config.risk.riskPerTradePct;
  const rawQty     = riskBudget / stopDistance;
  const qty        = Math.max(1, Math.floor(rawQty));

  // Cap at maxPositionPct of capital (nominal value)
  const maxPositionValue = totalCapital * config.risk.maxPositionPct;
  const cappedQty        = Math.min(qty, Math.floor(maxPositionValue / entryPrice));

  const stopLossPrice = entryPrice - stopDistance;

  log.info(
    `${symbol} sizing — ATR:${atr.toFixed(4)} | ` +
    `stopDist:$${stopDistance.toFixed(4)} (ATR×${config.risk.atrStopMultiplier} vs floor ${(config.risk.hardStopFloorPct * 100).toFixed(1)}%) | ` +
    `qty:${cappedQty} | stopLoss:$${stopLossPrice.toFixed(2)}`,
  );

  return { qty: cappedQty, stopLossPrice, atr };
}

// ---------------------------------------------------------------------------
// 3. Daily circuit breaker (+1% net PnL)
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
    await trader.liquidateAll('circuit-breaker-daily-target');
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 4. Active position management (scale-out +3% + trailing stop)
// ---------------------------------------------------------------------------

/**
 * Called on each real-time bar for held symbols.
 * Triggers scale-out at +3% and activates a trailing stop on the remainder.
 */
export async function handlePositionUpdate(
  symbol: string,
  currentPrice: number,
): Promise<void> {
  if (scaledOutPositions.has(symbol)) return;

  let position;
  try {
    position = await alpaca.getPosition(symbol);
  } catch {
    return;
  }

  const entryPrice    = parseFloat(position.avg_entry_price);
  const totalQty      = parseInt(position.qty, 10);
  const unrealizedPct = (currentPrice - entryPrice) / entryPrice;

  if (unrealizedPct >= config.risk.scaleOutTargetPct) {
    const sellQty = Math.floor(totalQty / 2);
    if (sellQty < 1) return;

    scaledOutPositions.add(symbol);
    log.info(
      `${symbol} — scale-out target reached ` +
      `(+${(unrealizedPct * 100).toFixed(2)}%) — selling ${sellQty}/${totalQty} shares`,
    );

    await trader.placeSellOrder(symbol, sellQty, 'scale-out');
    // Standard 1.5% trailing on remainder — break-even guaranteed since triggered at +3%
    await trader.replaceWithTrailingStop(symbol, config.risk.trailingStopPct);
  }
}

// ---------------------------------------------------------------------------
// 5. EOD sweep 15:45 EST (tight choke)
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
    const symbol       = pos.symbol;
    const currentPrice = parseFloat(pos.current_price);
    const positionPnl  = parseFloat(pos.unrealized_pl);
    const qty          = parseInt(pos.qty, 10);
    const data         = sessionData.get(symbol);

    if (!data) {
      log.warn(`${symbol}: no session data — conservative liquidation`);
      await trader.placeSellOrder(symbol, qty, 'eod-no-session-data');
      continue;
    }

    const isBelowVwap = currentPrice < data.vwap;
    const isInLoss    = positionPnl < 0;

    if (isBelowVwap || isInLoss) {
      log.info(
        `${symbol}: ` +
        `${isBelowVwap ? `price $${currentPrice.toFixed(2)} below VWAP $${data.vwap.toFixed(2)}` : ''} ` +
        `${isInLoss ? `negative PnL $${positionPnl.toFixed(2)}` : ''} — liquidating`,
      );
      // Cancel symbol's protection orders BEFORE selling (avoids accidental short)
      await trader.cancelOrdersForSymbol(symbol);
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
  }

  log.info('EOD sweep 15:45 done');
}

// ---------------------------------------------------------------------------
// 6. Hard close 15:58 EST
// ---------------------------------------------------------------------------

/**
 * Final cutoff: unconditionally liquidates all remaining positions.
 */
export async function runHardClose(): Promise<void> {
  log.warn('*** HARD CLOSE 15:58 EST *** Unconditional full liquidation');
  await trader.liquidateAll('hard-close-15h58');
  log.info('Hard close done');
}
