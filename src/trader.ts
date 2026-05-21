import alpaca from './alpacaClient';
import config from './config';
import { getESTDate, toErrorMessage } from './utils';
import { createLogger } from './logger';
import type { AlpacaOrder, AlpacaOrderParams, AlpacaPosition } from '@alpacahq/alpaca-trade-api';

const log = createLogger('TRADER');

interface QueueEntry {
  params:  AlpacaOrderParams;
  resolve: (order: AlpacaOrder) => void;
  reject:  (err: unknown) => void;
}

// Order queue — serializes submissions and absorbs rate limits
const orderQueue: QueueEntry[] = [];
let queueProcessing = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isInBlackoutPeriod(): boolean {
  const est = getESTDate();
  const h   = est.getHours();
  const m   = est.getMinutes();
  if (h < config.session.marketOpenHour) return true;
  if (h === config.session.marketOpenHour && m < config.session.blackoutEndMinute) return true;
  return false;
}

export async function getSettledCash(): Promise<number> {
  const account = await alpaca.getAccount();
  return parseFloat(account.cash);
}

export async function getAccountEquity(): Promise<number> {
  const account = await alpaca.getAccount();
  return parseFloat(account.equity);
}

export async function getOpenPositions(): Promise<AlpacaPosition[]> {
  return alpaca.getPositions();
}

export async function getOpenOrders(limit = 500): Promise<AlpacaOrder[]> {
  return alpaca.getOrders({ status: 'open', limit });
}

// ---------------------------------------------------------------------------
// Queue engine with exponential retry on HTTP 429
// ---------------------------------------------------------------------------

async function submitOrderWithRetry(
  orderParams: AlpacaOrderParams,
  attempt = 1,
  maxAttempts = 6,
): Promise<AlpacaOrder> {
  const baseDelay = 500;
  try {
    const order = await alpaca.createOrder(orderParams);
    log.info(
      `Order submitted — ${orderParams.symbol} ${orderParams.side} x${orderParams.qty} ` +
      `(id: ${order.id})`,
    );
    return order;
  } catch (err) {
    const is429 =
      err instanceof Error &&
      ((err as Error & { response?: { status?: number } }).response?.status === 429 ||
        err.message.includes('429'));

    if (is429 && attempt < maxAttempts) {
      const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), 30000);
      log.warn(
        `Rate limit on ${orderParams.symbol} — attempt ${attempt}/${maxAttempts} ` +
        `in ${delay}ms`,
      );
      await new Promise(resolve => setTimeout(resolve, delay));
      return submitOrderWithRetry(orderParams, attempt + 1, maxAttempts);
    }
    throw err;
  }
}

async function processQueue(): Promise<void> {
  if (queueProcessing || orderQueue.length === 0) return;
  queueProcessing = true;
  while (orderQueue.length > 0) {
    const entry = orderQueue.shift();
    if (!entry) break;
    const { params, resolve, reject } = entry;
    try {
      const result = await submitOrderWithRetry(params);
      resolve(result);
    } catch (err) {
      reject(err);
    }
    // Minimum pause between orders to avoid bursts
    await new Promise(r => setTimeout(r, 200));
  }
  queueProcessing = false;
}

function enqueueOrder(params: AlpacaOrderParams): Promise<AlpacaOrder> {
  return new Promise((resolve, reject) => {
    orderQueue.push({ params, resolve, reject });
    void processQueue();
  });
}

// ---------------------------------------------------------------------------
// Order cancellation
// ---------------------------------------------------------------------------

export async function cancelOrdersForSymbol(symbol: string): Promise<void> {
  const orders   = await alpaca.getOrders({ status: 'open', limit: 50 });
  const toCancel = orders.filter(o => o.symbol === symbol);
  for (const order of toCancel) {
    try {
      await alpaca.cancelOrder(order.id);
      log.info(`Order ${order.id} cancelled for ${symbol}`);
    } catch (err) {
      log.warn(`Cannot cancel order ${order.id}: ${toErrorMessage(err)}`);
    }
  }
}

export async function cancelAllOrders(): Promise<void> {
  const orders = await alpaca.getOrders({ status: 'open', limit: 500 });
  log.info(`Cancelling ${orders.length} pending order(s)...`);
  for (const order of orders) {
    try {
      await alpaca.cancelOrder(order.id);
      // Inter-cancellation pause to avoid 429 during mass sweeps
      await new Promise(r => setTimeout(r, 100));
    } catch (err) {
      log.warn(`Cannot cancel order ${order.id}: ${toErrorMessage(err)}`);
    }
  }
}

// Purges the in-memory queue — prevents stale orders post-liquidation
export function clearQueue(): void {
  const discarded = orderQueue.length;
  orderQueue.splice(0, orderQueue.length);
  if (discarded > 0) {
    log.info(`Queue purged — ${discarded} order(s) discarded`);
  }
}

// ---------------------------------------------------------------------------
// Full liquidation (circuit breaker / hard close)
// ---------------------------------------------------------------------------

export async function liquidateAll(reason: string): Promise<void> {
  // Purge in-memory queue BEFORE API calls to immediately cut pending orders
  clearQueue();
  await cancelAllOrders();
  const positions = await alpaca.getPositions();
  if (positions.length === 0) {
    log.info(`Liquidation (${reason}): no open positions`);
    return;
  }
  log.info(`Full liquidation (${reason}) — ${positions.length} position(s)`);
  for (const pos of positions) {
    const qty = parseInt(pos.qty, 10);
    if (qty > 0) {
      await placeSellOrder(pos.symbol, qty, reason);
    }
  }
}

// ---------------------------------------------------------------------------
// Order placement
// ---------------------------------------------------------------------------

/**
 * Bracket order on entry: stop-limit entry + attached stop-loss.
 * Checks: blackout period, settled cash, position cap, no duplicate position.
 */
export async function placeBracketOrder(
  symbol: string,
  qty: number,
  entryPrice: number,
  stopLossPrice: number,
): Promise<AlpacaOrder> {
  if (isInBlackoutPeriod()) {
    throw new Error(`Blackout active — order ${symbol} blocked until 09:45 EST`);
  }

  const [settledCash, positions] = await Promise.all([
    getSettledCash(),
    getOpenPositions(),
  ]);

  if (positions.some(p => p.symbol === symbol)) {
    throw new Error(`Position already open on ${symbol} — buy blocked`);
  }

  if (positions.length >= config.risk.maxPositions) {
    throw new Error(
      `Position cap of ${config.risk.maxPositions} reached — order ${symbol} blocked`,
    );
  }

  const requiredCash = entryPrice * qty;
  if (requiredCash > settledCash) {
    throw new Error(
      `Insufficient cash for ${symbol}: need $${requiredCash.toFixed(2)}, ` +
      `available $${settledCash.toFixed(2)}`,
    );
  }

  // Limit 0.1% above stop price to guarantee fill on a fast breakout
  const limitPrice         = parseFloat((entryPrice * 1.001).toFixed(2));
  const slipProtectionStop = parseFloat(entryPrice.toFixed(2));

  const orderParams: AlpacaOrderParams = {
    symbol,
    qty:           String(qty),
    side:          'buy',
    type:          'stop_limit',
    time_in_force: 'day',
    stop_price:    String(slipProtectionStop),
    limit_price:   String(limitPrice),
    order_class:   'bracket',
    stop_loss: {
      stop_price: String(parseFloat(stopLossPrice.toFixed(2))),
    },
  };

  log.info(
    `Bracket order — ${symbol} qty:${qty} entry~$${entryPrice.toFixed(2)} ` +
    `stop-loss:$${stopLossPrice.toFixed(2)}`,
  );

  return enqueueOrder(orderParams);
}

/**
 * Market sell order (scale-out, EOD liquidation, circuit breaker).
 */
export async function placeSellOrder(
  symbol: string,
  qty: number,
  reason = 'sell',
): Promise<AlpacaOrder> {
  const orderParams: AlpacaOrderParams = {
    symbol,
    qty:           String(qty),
    side:          'sell',
    type:          'market',
    time_in_force: 'day',
  };

  log.info(`Sell order — ${symbol} qty:${qty} reason:${reason}`);
  return enqueueOrder(orderParams);
}

/**
 * Cancels all open orders for a symbol, then places a trailing stop
 * on the remaining position.
 *
 * @param trailPercent - distance as decimal (e.g. 0.015 = 1.5%)
 */
export async function replaceWithTrailingStop(
  symbol: string,
  trailPercent: number,
): Promise<AlpacaOrder | null> {
  await cancelOrdersForSymbol(symbol);

  let position: AlpacaPosition;
  try {
    position = await alpaca.getPosition(symbol);
  } catch {
    log.info(`${symbol}: no position found for trailing stop`);
    return null;
  }

  const remainingQty = parseInt(position.qty, 10);
  if (remainingQty <= 0) return null;

  const orderParams: AlpacaOrderParams = {
    symbol,
    qty:           String(remainingQty),
    side:          'sell',
    type:          'trailing_stop',
    time_in_force: 'gtc',
    trail_percent: String((trailPercent * 100).toFixed(2)),
  };

  log.info(
    `Trailing stop activated — ${symbol} ${(trailPercent * 100).toFixed(2)}% ` +
    `on ${remainingQty} shares`,
  );
  return enqueueOrder(orderParams);
}
