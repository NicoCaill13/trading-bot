import { ATR } from 'technicalindicators';
import alpaca from './alpacaClient';
import config, { getSlotCapitalShare } from './config';
import * as trader from './trader';
import * as journalManager from './journalManager';
import { createLogger } from './logger';
import { toErrorMessage } from './utils';
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

// Prevents duplicate exit alerts when broker-side stops fill between bar events
// (tracked in positionManager — re-exported below)

// Starting reference for daily circuit breaker and drawdown kill-switch
let startOfDayEquity: number | null = null;
let circuitBreakerTriggered = false;
let drawdownKillTriggered = false;

// ---------------------------------------------------------------------------
// 1. Session initialization
// ---------------------------------------------------------------------------

export function initDailyBaseline(equity: number): void {
  startOfDayEquity = equity;
  circuitBreakerTriggered = false;
  drawdownKillTriggered = false;
  log.info(`Daily baseline initialized at $${equity.toFixed(2)}`);
}

// Exposed to let index.ts check the flag synchronously BEFORE tradingHalted is set
// — fixes the race condition with the debounce timer
export function isCircuitBreakerTriggered(): boolean {
  return circuitBreakerTriggered;
}

export function isDrawdownKillTriggered(): boolean {
  return drawdownKillTriggered;
}

/**
 * Returns true when the position was closed by a broker-side order
 * (stop-loss or trailing stop fill) without a direct placeSellOrder call.
 */
export { wasExternallyExited, wasScaledOut, markScaledOut } from './positionManager';

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

async function fetchAtr5m(symbol: string): Promise<number> {
  const period = config.indicators.atrPeriod;
  const needed = period + 5;
  const end = new Date();
  const start = new Date(end.getTime() - needed * 5 * 60 * 1000 * 2);

  const highs: number[] = [];
  const lows: number[] = [];
  const closes: number[] = [];

  const iter = alpaca.getBarsV2(symbol, {
    start: start.toISOString(),
    end: end.toISOString(),
    timeframe: '5Min',
    feed: 'iex',
  });

  for await (const bar of iter) {
    highs.push(bar.HighPrice);
    lows.push(bar.LowPrice);
    closes.push(bar.ClosePrice);
  }

  if (highs.length < period + 1) {
    throw new Error(
      `${symbol}: insufficient 5m history for ATR (${highs.length} bars)`,
    );
  }

  const atrValues = ATR.calculate({ period, high: highs, low: lows, close: closes });
  const atr = atrValues[atrValues.length - 1];

  if (!atr || atr <= 0) {
    throw new Error(`${symbol}: invalid 5m ATR value (${atr})`);
  }

  return atr;
}

/**
 * Computes position size and stop level coherently (CTPO slot equiparity).
 *
 * Stop distance uses 5-min ATR × atrStopMultiplier5m (V6 spec: 1.0 × ATR(5m)).
 * Returned `atr` is the 5-min value used by positionManager for dynamic exits.
 */
export async function computePositionSize(
  symbol: string,
  entryPrice: number,
  _totalCapital: number,
  tier: SignalTier = 'core',
  positionTiers: Map<string, SignalTier> = new Map(),
): Promise<PositionSizeResult> {
  const atr = await fetchAtr5m(symbol);

  // Stop coherent with sizing — hard-stop acts as safety floor
  const atrStopDistance = atr * config.risk.atrStopMultiplier5m;
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
  // Each slot deploys a fixed 1/maxPositions share of total equity.
  // ATR is used exclusively to place the stop — not to size the position.
  const positionCapital = totalEquity * getSlotCapitalShare();
  const qty = Math.floor(positionCapital / entryPrice);

  if (qty < 1) {
    throw new Error(
      `${symbol}: slot envelope insufficient — ` +
      `positionCapital $${positionCapital.toFixed(2)} for ~$${entryPrice.toFixed(2)}/share`,
    );
  }

  const stopLossPrice = entryPrice - stopDistance;

  log.info(
    `${symbol} sizing [${tier}] — ATR(5m):${atr.toFixed(4)} | ` +
    `slot ${(getSlotCapitalShare() * 100).toFixed(0)}% equity ($${positionCapital.toFixed(0)}) | ` +
    `notional $${(qty * entryPrice).toFixed(0)} / $${totalEquity.toFixed(0)} equity | ` +
    `stopDist:$${stopDistance.toFixed(4)} | qty:${qty} | stopLoss:$${stopLossPrice.toFixed(2)}`,
  );

  return { qty, stopLossPrice, atr };
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
// 4b. Daily drawdown kill-switch (-1.5% / -$1,500)
// ---------------------------------------------------------------------------

/**
 * Halts trading when daily net PnL breaches the drawdown limit.
 * Liquidates all positions and cancels open orders.
 */
export async function checkDailyDrawdownKillSwitch(currentEquity: number): Promise<boolean> {
  if (drawdownKillTriggered || startOfDayEquity === null) return false;

  const dailyPnlDollars = currentEquity - startOfDayEquity;
  const dailyPnlPct = dailyPnlDollars / startOfDayEquity;

  const hitDollarLimit = dailyPnlDollars <= config.risk.dailyDrawdownLimitDollars;
  const hitPctLimit = dailyPnlPct <= config.risk.dailyDrawdownLimitPct;

  if (!hitDollarLimit && !hitPctLimit) return false;

  drawdownKillTriggered = true;
  log.warn(
    `*** DAILY DRAWDOWN KILL-SWITCH *** ` +
    `Net PnL $${dailyPnlDollars.toFixed(2)} (${(dailyPnlPct * 100).toFixed(2)}%) — HALTED`,
  );
  journalManager.closeAllOpenTrades('daily-drawdown-kill');
  await trader.liquidateAll('daily-drawdown-kill');
  return true;
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
// 6. Hard close 15:58 EST
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
