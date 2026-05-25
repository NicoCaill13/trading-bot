import alpaca from './alpacaClient';
import config from './config';
import { getESTDate, toErrorMessage } from './utils';
import { createLogger } from './logger';
import {
  sendTelegramAlert,
  formatEntryAlert,
  formatTakeProfitAlert,
  formatExitAlert,
  formatErrorAlert,
  humanizeExitReason,
} from './notificationManager';
import type { AlpacaOrder, AlpacaOrderParams, AlpacaPosition, AlpacaSnapshot } from '@alpacahq/alpaca-trade-api';
import type { BarData, SignalTier } from './types';

const log = createLogger('TRADER');

interface QueueEntry {
  params: AlpacaOrderParams;
  resolve: (order: AlpacaOrder) => void;
  reject: (err: unknown) => void;
}

// Order queue — serializes submissions and absorbs rate limits
const orderQueue: QueueEntry[] = [];
let queueProcessing = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isInBlackoutPeriod(): boolean {
  const est = getESTDate();
  const h = est.getHours();
  const m = est.getMinutes();
  if (h < config.session.marketOpenHour) return true;
  if (h === config.session.marketOpenHour && m < config.session.blackoutEndMinute) return true;
  return false;
}

// True before 09:30 (cash market not yet open).
function isPreMarketPeriod(): boolean {
  const est = getESTDate();
  const h = est.getHours();
  const m = est.getMinutes();
  return (
    h < config.session.marketOpenHour ||
    (h === config.session.marketOpenHour && m < config.session.marketOpenMinute)
  );
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

type HttpErrorShape = Error & { response?: { status?: number; data?: unknown } };

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
    const httpErr = err as HttpErrorShape;
    const status  = httpErr.response?.status;
    const body    = httpErr.response?.data;

    const is429 = status === 429 || (err instanceof Error && err.message.includes('429'));

    if (is429 && attempt < maxAttempts) {
      const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), 30000);
      log.warn(
        `Rate limit on ${orderParams.symbol} — attempt ${attempt}/${maxAttempts} ` +
        `in ${delay}ms`,
      );
      await new Promise(resolve => setTimeout(resolve, delay));
      return submitOrderWithRetry(orderParams, attempt + 1, maxAttempts);
    }

    // Surface the full Alpaca error body on any 4xx so the root cause is visible in logs
    if (status !== undefined && status >= 400 && status < 500) {
      log.error(
        `Order rejected HTTP ${status} — ${orderParams.symbol} ${orderParams.side} ` +
        `x${orderParams.qty}: ${JSON.stringify(body ?? toErrorMessage(err))}`,
      );
      void sendTelegramAlert(
        formatErrorAlert(
          `Ordre rejeté HTTP ${status} — ${orderParams.symbol} ${orderParams.side} x${orderParams.qty}`,
        ),
      );
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

/** Collects every open order id for a symbol (parents + nested legs). */
function collectOpenOrderIds(symbol: string, orders: AlpacaOrder[]): string[] {
  const ids = new Set<string>();

  for (const order of orders) {
    if (order.symbol !== symbol) continue;
    ids.add(order.id);
    order.legs?.forEach(leg => {
      if (leg.symbol === symbol || leg.symbol === undefined) {
        ids.add(leg.id);
      }
    });
  }

  return [...ids];
}

/**
 * Cancels all open orders for a symbol (parents + OTO legs).
 * Returns the number of orders that could NOT be cancelled (API errors).
 * Callers that sell immediately after must abort when failedCancels > 0 to
 * avoid a 403 from Alpaca (held_for_orders still covers the full position qty).
 */
export async function cancelOrdersForSymbol(symbol: string): Promise<number> {
  const orders = await alpaca.getOrders({
    status: 'open',
    limit:  100,
    nested: true,
    symbols: symbol,
  });

  const orderIds = collectOpenOrderIds(symbol, orders);
  if (orderIds.length === 0) {
    log.info(`${symbol}: no open orders to cancel`);
    return 0;
  }

  log.info(`${symbol}: cancelling ${orderIds.length} open order(s)...`);

  let failedCancels = 0;
  for (const orderId of orderIds) {
    try {
      await alpaca.cancelOrder(orderId);
      log.info(`Order ${orderId} cancelled for ${symbol}`);
    } catch (err) {
      log.warn(`Cannot cancel order ${orderId}: ${toErrorMessage(err)}`);
      failedCancels++;
    }
  }
  return failedCancels;
}

/**
 * Partial exit triggered by a UT1m take-profit target (5% Core / 7% Satellite).
 *
 * Sequence:
 *   1. Cancel the existing stop-loss (which sits at -ATR distance below entry).
 *   2. Sell sellQty shares at market (50% of the position).
 *   3. After settlement: place a trailing stop on the remaining 50%.
 *      When placed at +targetPct, a 1.5% trail creates an effective floor of
 *      targetPct × (1 - 0.015) above entry — strictly above break-even.
 *
 * The stop must be cancelled BEFORE the market sell — Alpaca returns 403 when open
 * sell orders already cover the full position qty.
 *
 * @param sellQty    - Math.floor(totalQty / 2) — no fractional shares
 * @param entryPrice - avg_entry_price for break-even floor calculation and logging
 * @param targetPct  - 0.05 or 0.07 — the threshold that triggered this call
 * @param tierLabel  - 'Core' or 'Satellite' — used in the log line
 */
export async function executeBreakEvenScaleOut(
  symbol: string,
  sellQty: number,
  entryPrice: number,
  targetPct: number,
  tierLabel: 'Core' | 'Satellite',
): Promise<void> {
  const targetLabel = `${(targetPct * 100).toFixed(0)}%`;
  const breakEvenFloor = parseFloat(
    (entryPrice * (1 + targetPct) * (1 - config.risk.trailingStopPct)).toFixed(2),
  );

  log.info(
    `[UT1M] ${tierLabel} Target ${targetLabel} hit for ${symbol}. ` +
    `Selling 50% (qty: ${sellQty}). Moving remaining stop to Break-Even.`,
  );

  const failedCancels = await cancelOrdersForSymbol(symbol);
  if (failedCancels > 0) {
    // One or more stop orders could not be cancelled — Alpaca still holds the full
    // position qty for those orders. Selling now would produce a 403. Abort and let
    // the next bar retry (the stop order will either complete its cancel or fill).
    throw new Error(
      `${symbol}: scale-out aborted — ${failedCancels} order cancellation(s) failed; ` +
      `shares still held. Will retry next bar.`,
    );
  }

  // Allow Alpaca to propagate the cancellation before submitting the sell.
  // Without this pause, held_for_orders can still cover the full qty for ~300-500 ms
  // after a successful cancel ACK, causing a 403 on the partial sell.
  await new Promise(r => setTimeout(r, 500));

  await placeSellOrder(symbol, sellQty, `tp-${targetLabel}`);

  void sendTelegramAlert(formatTakeProfitAlert(symbol));

  setTimeout(() => {
    log.info(
      `${symbol}: trailing stop on remainder — ` +
      `effective floor ~$${breakEvenFloor.toFixed(2)} (break-even $${entryPrice.toFixed(2)})`,
    );
    replaceWithTrailingStop(symbol, config.risk.trailingStopPct).catch(
      (err: unknown) => {
        log.warn(
          `${symbol}: trailing stop after break-even scale-out failed — ${toErrorMessage(err)}`,
        );
      },
    );
  }, config.risk.scaleOutSettlementDelayMs);
}

export async function cancelAllOrders(): Promise<void> {
  // nested:true ensures OTO/bracket child orders (stop-losses) surface as legs
  // when the parent entry is still pending — both cases are collapsed into a flat id set.
  const orders = await alpaca.getOrders({ status: 'open', limit: 500, nested: true });

  const ids = new Set<string>();
  for (const order of orders) {
    ids.add(order.id);
    order.legs?.forEach(leg => ids.add(leg.id));
  }

  log.info(`Cancelling ${ids.size} pending order(s)...`);
  for (const orderId of ids) {
    try {
      await alpaca.cancelOrder(orderId);
      // Inter-cancellation pause to avoid 429 during mass sweeps
      await new Promise(r => setTimeout(r, 100));
    } catch (err) {
      log.warn(`Cannot cancel order ${orderId}: ${toErrorMessage(err)}`);
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

  // Allow broker-side cancellations to propagate before submitting sells.
  // Without this delay, a stop-loss that Alpaca acknowledged-cancelled can still
  // appear as covering the full qty for ~300–500 ms, causing 403 on the market sell.
  await new Promise(r => setTimeout(r, 500));

  const positions = await alpaca.getPositions();
  if (positions.length === 0) {
    log.info(`Liquidation (${reason}): no open positions`);
    return;
  }
  log.info(`Full liquidation (${reason}) — ${positions.length} position(s)`);
  for (const pos of positions) {
    const qty = parseInt(pos.qty, 10);
    if (qty <= 0) continue;
    try {
      await placeSellOrder(pos.symbol, qty, reason);
    } catch (err) {
      // Log and continue — one failed sell must not block the remaining positions
      log.error(`Liquidation: ${pos.symbol} sell failed — ${toErrorMessage(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Order placement
// ---------------------------------------------------------------------------

/**
 * Resolves the most aggressive (highest) available price anchor from a snapshot.
 * Priority: ask > last trade > minute bar close.
 * Returns null when no live price data is available.
 */
function resolveAskPrice(snap: AlpacaSnapshot): number | null {
  const ask = snap.LatestQuote?.AskPrice;
  if (ask !== undefined && ask > 0) return ask;

  const lastTrade = snap.LatestTrade?.Price;
  if (lastTrade !== undefined && lastTrade > 0) return lastTrade;

  const minuteClose = snap.MinuteBar?.ClosePrice;
  if (minuteClose !== undefined && minuteClose > 0) return minuteClose;

  return null;
}

/**
 * Fetches the live ask price for a symbol.
 * Falls back to signalPrice when the snapshot call fails.
 */
async function fetchLiveAskPrice(symbol: string, signalPrice: number): Promise<number> {
  try {
    const snapshots = await alpaca.getSnapshots([symbol]);
    const snap = snapshots.find(
      s => (s.Symbol ?? (s as { symbol?: string }).symbol) === symbol,
    );
    if (!snap) return signalPrice;

    const ask = resolveAskPrice(snap);
    return ask ?? signalPrice;
  } catch {
    return signalPrice;
  }
}

/**
 * Marketable buy limit anchored on live ask at submission time.
 * Prevents 422 from stale bar close + debounce latency.
 */
function computeMarketableLimitPrice(askPrice: number): number {
  const mult = config.entry.marketableLimitVwapMultiplier;
  return parseFloat((askPrice * mult).toFixed(2));
}

/**
 * Bracket order on entry: aggressive marketable limit + stop-loss.
 * Core entries respect opening blackout; Satellite (ORB) may enter during blackout.
 */
export async function placeBracketOrder(
  symbol: string,
  qty: number,
  vwap: number,
  signalPrice: number,
  stopLossPrice: number,
  tier: SignalTier = 'core',
): Promise<AlpacaOrder> {
  if (tier === 'core' && isInBlackoutPeriod()) {
    throw new Error(`Blackout active — Core order ${symbol} blocked until 09:45 EST`);
  }
  if (tier === 'satellite' && isPreMarketPeriod()) {
    throw new Error(`Pre-market — Satellite order ${symbol} blocked before 09:30 EST`);
  }

  // Fetch live ask price at submission time — bar close can be 0-5 min stale + 10s debounce.
  // Using a stale price produces a non-marketable limit (422) when price runs up.
  const liveAskPrice = await fetchLiveAskPrice(symbol, signalPrice);

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

  const limitPrice = computeMarketableLimitPrice(liveAskPrice);

  const requiredCash = limitPrice * qty;
  if (requiredCash > settledCash) {
    throw new Error(
      `Insufficient cash for ${symbol}: need $${requiredCash.toFixed(2)}, ` +
      `available $${settledCash.toFixed(2)}`,
    );
  }

  // order_class 'oto' (One-Triggers-Other): when the entry fills, the stop-loss
  // child order is automatically placed. Take-profit is handled manually by
  // handlePositionUpdate (+3% scale-out + trailing stop) — no take_profit leg needed.
  // 'bracket' requires BOTH stop_loss and take_profit; using it without take_profit
  // causes an unconditional 422.
  const orderParams: AlpacaOrderParams = {
    symbol,
    qty: String(qty),
    side: 'buy',
    type: 'limit',
    time_in_force: 'day',
    limit_price: String(limitPrice),
    order_class: 'oto',
    stop_loss: {
      stop_price: String(parseFloat(stopLossPrice.toFixed(2))),
    },
  };

  log.info(
    `Marketable limit entry [${tier}] — ${symbol} qty:${qty} ` +
    `limit:$${limitPrice.toFixed(2)} (ask $${liveAskPrice.toFixed(2)} × ${config.entry.marketableLimitVwapMultiplier}) ` +
    `stop-loss:$${stopLossPrice.toFixed(2)}`,
  );

  const order = await enqueueOrder(orderParams);

  void sendTelegramAlert(
    formatEntryAlert(qty, symbol, tier, limitPrice, stopLossPrice),
  );

  return order;
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
    qty: String(qty),
    side: 'sell',
    type: 'market',
    time_in_force: 'day',
  };

  log.info(`Sell order — ${symbol} qty:${qty} reason:${reason}`);

  if (!reason.startsWith('tp-')) {
    void sendTelegramAlert(
      formatExitAlert(symbol, humanizeExitReason(reason)),
    );
  }

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
    qty: String(remainingQty),
    side: 'sell',
    type: 'trailing_stop',
    time_in_force: 'gtc',
    trail_percent: String((trailPercent * 100).toFixed(2)),
  };

  log.info(
    `Trailing stop activated — ${symbol} ${(trailPercent * 100).toFixed(2)}% ` +
    `on ${remainingQty} shares`,
  );
  return enqueueOrder(orderParams);
}

// ---------------------------------------------------------------------------
// Satellite volume confirmation — break candle must exceed VMA_10 (1-min)
// ---------------------------------------------------------------------------

/**
 * Returns false when the Satellite break candle lacks volume conviction.
 * Prevents fakeout entries: buy is only allowed when break bar volume > VMA_10
 * computed on the preceding 1-min bars (10-bar rolling mean).
 */
export function passesSatelliteVolumeConfirmation(
  breakBar: BarData,
  oneMinBars: BarData[],
): boolean {
  const period = config.risk.volumeConfirmationVmaPeriod;
  const priorBars = oneMinBars.filter(b => b.timestamp !== breakBar.timestamp);
  if (priorBars.length < period) return false;

  const vma10 = priorBars.slice(-period).reduce((sum, b) => sum + b.volume, 0) / period;
  if (vma10 <= 0) return false;

  return breakBar.volume > vma10;
}
