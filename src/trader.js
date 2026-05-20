'use strict';

const Alpaca = require('@alpacahq/alpaca-trade-api');
const config = require('./config');

const alpaca = new Alpaca({
  keyId: config.alpaca.keyId,
  secretKey: config.alpaca.secretKey,
  baseUrl: config.alpaca.baseUrl,
  paper: config.alpaca.paper,
});

// In-memory queue for rate-limited order retries
const orderQueue = [];
let queueProcessing = false;

function getESTDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

function isInBlackoutPeriod() {
  const est = getESTDate();
  const h = est.getHours();
  const m = est.getMinutes();
  if (h < config.session.marketOpenHour) return true;
  if (h === config.session.marketOpenHour && m < config.session.blackoutEndMinute) return true;
  return false;
}

async function getSettledCash() {
  const account = await alpaca.getAccount();
  // cash = settled cash only — no unsettled funds from T+1
  return parseFloat(account.cash);
}

async function getOpenPositions() {
  return await alpaca.getPositions();
}

// Submit an order with automatic retry on 429 rate-limit errors
async function submitOrderWithRetry(orderParams, attempt = 1, maxAttempts = 5) {
  const baseDelay = 500;
  try {
    const order = await alpaca.createOrder(orderParams);
    console.log(`[TRADER] Order submitted — ${orderParams.symbol} ${orderParams.side} x${orderParams.qty} (id: ${order.id})`);
    return order;
  } catch (err) {
    const is429 = err.response?.status === 429 || (err.message && err.message.includes('429'));
    if (is429 && attempt < maxAttempts) {
      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.log(`[TRADER] Rate limit hit for ${orderParams.symbol}, retry ${attempt}/${maxAttempts} in ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return submitOrderWithRetry(orderParams, attempt + 1, maxAttempts);
    }
    throw err;
  }
}

async function processQueue() {
  if (queueProcessing || orderQueue.length === 0) return;
  queueProcessing = true;
  while (orderQueue.length > 0) {
    const { params, resolve, reject } = orderQueue.shift();
    try {
      const result = await submitOrderWithRetry(params);
      resolve(result);
    } catch (err) {
      reject(err);
    }
    await new Promise(r => setTimeout(r, 200));
  }
  queueProcessing = false;
}

function enqueueOrder(params) {
  return new Promise((resolve, reject) => {
    orderQueue.push({ params, resolve, reject });
    processQueue();
  });
}

/**
 * Place a bracket order (entry + stop-loss) for a given symbol.
 * Entry is a stop-limit order to avoid slippage on breakout.
 *
 * @param {string} symbol
 * @param {number} qty - number of shares
 * @param {number} entryPrice - current ask / breakout price
 * @param {number} stopLossPrice - pre-computed stop-loss level
 * @returns {Promise<object>} Alpaca order object
 */
async function placeBracketOrder(symbol, qty, entryPrice, stopLossPrice) {
  if (isInBlackoutPeriod()) {
    const msg = `[TRADER] Blackout period active — order for ${symbol} blocked until 09:45 EST`;
    console.log(msg);
    throw new Error(msg);
  }

  const settledCash = await getSettledCash();
  const requiredCash = entryPrice * qty;
  if (requiredCash > settledCash) {
    const msg = `[TRADER] Insufficient settled cash for ${symbol}: need $${requiredCash.toFixed(2)}, available $${settledCash.toFixed(2)}`;
    console.log(msg);
    throw new Error(msg);
  }

  const positions = await getOpenPositions();
  if (positions.length >= config.risk.maxPositions) {
    const msg = `[TRADER] Max positions reached (${config.risk.maxPositions}) — order for ${symbol} blocked`;
    console.log(msg);
    throw new Error(msg);
  }

  // Aggressive stop-limit: limit = 0.1% above stop to ensure fill on fast breakouts
  const limitPrice = parseFloat((entryPrice * 1.001).toFixed(2));
  const slipProtectionStop = parseFloat(entryPrice.toFixed(2));

  const orderParams = {
    symbol,
    qty: String(qty),
    side: 'buy',
    type: 'stop_limit',
    time_in_force: 'day',
    stop_price: String(slipProtectionStop),
    limit_price: String(limitPrice),
    order_class: 'bracket',
    stop_loss: {
      stop_price: String(parseFloat(stopLossPrice.toFixed(2))),
    },
  };

  console.log(
    `[TRADER] Placing bracket order — ${symbol} qty:${qty} entry~$${entryPrice.toFixed(2)} ` +
    `stop-loss:$${stopLossPrice.toFixed(2)}`,
  );

  return enqueueOrder(orderParams);
}

/**
 * Place a market sell order (used for scaling-out, EOD liquidation).
 *
 * @param {string} symbol
 * @param {number} qty
 * @param {string} reason - logging context
 */
async function placeSellOrder(symbol, qty, reason = 'sell') {
  const orderParams = {
    symbol,
    qty: String(qty),
    side: 'sell',
    type: 'market',
    time_in_force: 'day',
  };

  console.log(`[TRADER] Placing sell order — ${symbol} qty:${qty} reason:${reason}`);
  return enqueueOrder(orderParams);
}

/**
 * Cancel all open orders for a symbol, then replace the stop-loss leg
 * with a new trailing stop order.
 *
 * @param {string} symbol
 * @param {number} trailPercent - trailing distance as decimal (e.g. 0.015)
 */
async function replaceWithTrailingStop(symbol, trailPercent) {
  // Cancel all pending orders for this symbol
  const orders = await alpaca.getOrders({ status: 'open', symbols: [symbol], limit: 50 });
  for (const order of orders) {
    try {
      await alpaca.cancelOrder(order.id);
      console.log(`[TRADER] Cancelled order ${order.id} for ${symbol} before trailing stop replacement`);
    } catch (err) {
      console.log(`[TRADER] Could not cancel order ${order.id}: ${err.message}`);
    }
  }

  const position = await alpaca.getPosition(symbol).catch(() => null);
  if (!position) {
    console.log(`[TRADER] No open position found for ${symbol} — trailing stop skipped`);
    return null;
  }

  const remainingQty = parseInt(position.qty, 10);
  if (remainingQty <= 0) return null;

  const orderParams = {
    symbol,
    qty: String(remainingQty),
    side: 'sell',
    type: 'trailing_stop',
    time_in_force: 'gtc',
    trail_percent: String((trailPercent * 100).toFixed(2)),
  };

  console.log(`[TRADER] Activating trailing stop for ${symbol} — ${(trailPercent * 100).toFixed(2)}% trail on ${remainingQty} shares`);
  return enqueueOrder(orderParams);
}

module.exports = {
  placeBracketOrder,
  placeSellOrder,
  replaceWithTrailingStop,
  getSettledCash,
  getOpenPositions,
  getESTDate,
};
