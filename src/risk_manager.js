'use strict';

const { ATR } = require('technicalindicators');
const Alpaca = require('@alpacahq/alpaca-trade-api');
const config = require('./config');
const trader = require('./trader');

const alpaca = new Alpaca({
  keyId: config.alpaca.keyId,
  secretKey: config.alpaca.secretKey,
  baseUrl: config.alpaca.baseUrl,
  paper: config.alpaca.paper,
});

// Track which positions have already been scaled out to avoid double-execution
const scaledOutPositions = new Set();

// ---------------------------------------------------------------------------
// 1. ATR-based position sizing
// ---------------------------------------------------------------------------

/**
 * Compute ATR for a symbol using daily bars, then derive share quantity
 * such that the monetary risk (entry → stop) equals a fixed fraction of capital.
 *
 * @param {string} symbol
 * @param {number} entryPrice
 * @param {number} totalCapital - total settled cash available
 * @returns {Promise<{qty: number, stopLossPrice: number, atr: number}>}
 */
async function computePositionSize(symbol, entryPrice, totalCapital) {
  const period = config.indicators.atrPeriod;
  const needed = period + 5;

  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - (needed + 2));

  const bars = [];
  const iter = alpaca.getBarsV2(symbol, {
    start: start.toISOString().split('T')[0],
    end: end.toISOString().split('T')[0],
    timeframe: '1Day',
    limit: needed + 5,
    feed: 'iex',
  });

  for await (const bar of iter) {
    bars.push(bar);
  }

  if (bars.length < period + 1) {
    throw new Error(`[RISK_MANAGER] ${symbol}: not enough bars for ATR (${bars.length})`);
  }

  const highs = bars.map(b => b.HighPrice);
  const lows = bars.map(b => b.LowPrice);
  const closes = bars.map(b => b.ClosePrice);

  const atrValues = ATR.calculate({ period, high: highs, low: lows, close: closes });
  const atr = atrValues[atrValues.length - 1];

  if (!atr || atr <= 0) {
    throw new Error(`[RISK_MANAGER] ${symbol}: invalid ATR value (${atr})`);
  }

  // Risk per trade = maxPositionPct * totalCapital * stopLossPct
  // Stop distance = 1 × ATR (minimum of ATR and fixed stop)
  const fixedStopDistance = entryPrice * config.risk.stopLossPct;
  const stopDistance = Math.min(atr, fixedStopDistance);

  const riskBudgetPerTrade = totalCapital * config.risk.maxPositionPct * config.risk.stopLossPct;
  const rawQty = riskBudgetPerTrade / stopDistance;
  const qty = Math.max(1, Math.floor(rawQty));

  // Cap position value to maxPositionPct of capital
  const maxPositionValue = totalCapital * config.risk.maxPositionPct;
  const cappedQty = Math.min(qty, Math.floor(maxPositionValue / entryPrice));

  const stopLossPrice = entryPrice - stopDistance;

  console.log(
    `[RISK_MANAGER] ${symbol} sizing — ATR:${atr.toFixed(4)} stopDist:${stopDistance.toFixed(4)} ` +
    `qty:${cappedQty} stopLoss:$${stopLossPrice.toFixed(2)}`,
  );

  return { qty: cappedQty, stopLossPrice, atr };
}

// ---------------------------------------------------------------------------
// 2. Active position management — scale-out + trailing stop
// ---------------------------------------------------------------------------

/**
 * Called on every live price update for symbols in portfolio.
 * Handles scale-out at +2% and trailing stop activation.
 *
 * @param {string} symbol
 * @param {number} currentPrice
 */
async function handlePositionUpdate(symbol, currentPrice) {
  if (scaledOutPositions.has(symbol)) return;

  let position;
  try {
    position = await alpaca.getPosition(symbol);
  } catch {
    return;
  }

  const entryPrice = parseFloat(position.avg_entry_price);
  const totalQty = parseInt(position.qty, 10);
  const unrealizedPct = (currentPrice - entryPrice) / entryPrice;

  if (unrealizedPct >= config.risk.scaleOutTargetPct) {
    const sellQty = Math.floor(totalQty / 2);
    if (sellQty < 1) return;

    scaledOutPositions.add(symbol);
    console.log(
      `[RISK_MANAGER] ${symbol} hit scale-out target (+${(unrealizedPct * 100).toFixed(2)}%) — ` +
      `selling ${sellQty}/${totalQty} shares`,
    );

    await trader.placeSellOrder(symbol, sellQty, 'scale-out');

    // Move stop to break-even on remaining shares via trailing stop
    await trader.replaceWithTrailingStop(symbol, config.risk.trailingStopPct);
  }
}

// ---------------------------------------------------------------------------
// 3. End-of-day sweep (15:45 EST)
// ---------------------------------------------------------------------------

/**
 * End-of-day risk arbitage:
 * - If overall PnL is negative, liquidate worst performers first to reach neutral
 * - For survivors: keep overnight only if price > VWAP and near session highs
 *
 * @param {Map<string, {vwap: number, high: number}>} sessionData - intraday VWAP + high per symbol
 */
async function runEodSweep(sessionData) {
  console.log('[RISK_MANAGER] Starting end-of-day sweep at 15:45 EST...');

  const [account, positions] = await Promise.all([
    alpaca.getAccount(),
    alpaca.getPositions(),
  ]);

  if (positions.length === 0) {
    console.log('[RISK_MANAGER] No open positions — sweep complete');
    return;
  }

  const totalPnl = positions.reduce((sum, p) => sum + parseFloat(p.unrealized_pl), 0);
  console.log(`[RISK_MANAGER] Total unrealized PnL: $${totalPnl.toFixed(2)}`);

  if (totalPnl < 0) {
    // Sort by PnL ascending (worst first)
    const sorted = [...positions].sort(
      (a, b) => parseFloat(a.unrealized_pl) - parseFloat(b.unrealized_pl),
    );

    let runningPnl = totalPnl;
    for (const pos of sorted) {
      if (runningPnl >= 0) break;
      const positionPnl = parseFloat(pos.unrealized_pl);
      const qty = parseInt(pos.qty, 10);
      console.log(
        `[RISK_MANAGER] EOD liquidating ${pos.symbol} (PnL: $${positionPnl.toFixed(2)}) to restore neutral balance`,
      );
      await trader.placeSellOrder(pos.symbol, qty, 'eod-balance-restore');
      runningPnl -= positionPnl; // removing a loss improves PnL
    }
  }

  // Re-fetch after partial liquidations
  const remainingPositions = await alpaca.getPositions();

  for (const pos of remainingPositions) {
    const symbol = pos.symbol;
    const currentPrice = parseFloat(pos.current_price);
    const data = sessionData.get(symbol);

    if (!data) {
      // No session data available — liquidate conservatively
      console.log(`[RISK_MANAGER] ${symbol}: no session data, liquidating before close`);
      await trader.placeSellOrder(symbol, parseInt(pos.qty, 10), 'eod-no-data');
      continue;
    }

    const aboveVwap = currentPrice > data.vwap;
    // "Near session highs" = within 1% of the intraday high
    const nearHigh = (data.high - currentPrice) / data.high < 0.01;

    if (aboveVwap && nearHigh) {
      console.log(`[RISK_MANAGER] ${symbol}: price $${currentPrice.toFixed(2)} above VWAP $${data.vwap.toFixed(2)} near high $${data.high.toFixed(2)} — keeping overnight (swing)`);
    } else {
      console.log(`[RISK_MANAGER] ${symbol}: conditions not met for overnight — liquidating`);
      await trader.placeSellOrder(symbol, parseInt(pos.qty, 10), 'eod-liquidation');
    }
  }

  console.log('[RISK_MANAGER] End-of-day sweep complete');
}

module.exports = {
  computePositionSize,
  handlePositionUpdate,
  runEodSweep,
};
