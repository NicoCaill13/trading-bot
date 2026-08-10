import { isNearVwap } from './vwapSetup';
import type {
  ImbalanceSignal,
  OrderBookLevel,
  OrderBookSnapshot,
  WsQuoteMessage,
} from './types';

export interface BuyWallThresholds {
  imbalanceThreshold: number;
  vwapProximityPct: number;
}

/**
 * bidSizeSum / (bidSizeSum + askSizeSum) over provided levels.
 * Returns null when total size is zero.
 */
export function computeImbalance(
  bids: readonly OrderBookLevel[],
  asks: readonly OrderBookLevel[],
): number | null {
  const bidSum = bids.reduce((s, l) => s + Math.max(0, l.size), 0);
  const askSum = asks.reduce((s, l) => s + Math.max(0, l.size), 0);
  const total = bidSum + askSum;
  if (total <= 0) return null;
  return bidSum / total;
}

/**
 * Build a snapshot from an IEX top-of-book quote.
 * `topN` is accepted for future multi-level feeds; IEX only has 1 level.
 */
export function quoteToSnapshot(
  quote: WsQuoteMessage,
  _topN = 5,
): OrderBookSnapshot {
  const bids: OrderBookLevel[] =
    quote.bp > 0 && quote.bs > 0 ? [{ price: quote.bp, size: quote.bs }] : [];
  const asks: OrderBookLevel[] =
    quote.ap > 0 && quote.as > 0 ? [{ price: quote.ap, size: quote.as }] : [];

  let mid: number | null = null;
  if (quote.bp > 0 && quote.ap > 0) {
    mid = (quote.bp + quote.ap) / 2;
  } else if (quote.bp > 0) {
    mid = quote.bp;
  } else if (quote.ap > 0) {
    mid = quote.ap;
  }

  return {
    symbol: quote.S,
    bids,
    asks,
    mid,
    timestamp: quote.t,
  };
}

/** Buy wall when imbalance >= threshold and mid is near VWAP. */
export function detectBuyWall(
  imbalance: number | null,
  mid: number | null,
  vwap: number | null,
  thresholds: BuyWallThresholds,
): boolean {
  if (imbalance === null || mid === null || vwap === null || vwap <= 0) {
    return false;
  }
  if (imbalance < thresholds.imbalanceThreshold) return false;
  return isNearVwap(mid, vwap, thresholds.vwapProximityPct);
}

export function assessQuoteForWall(
  quote: WsQuoteMessage,
  vwap: number | null,
  opts: BuyWallThresholds & { topN?: number; assessedAt?: number },
): ImbalanceSignal {
  const snapshot = quoteToSnapshot(quote, opts.topN ?? 5);
  const imbalance = computeImbalance(snapshot.bids, snapshot.asks);
  const wall = detectBuyWall(imbalance, snapshot.mid, vwap, {
    imbalanceThreshold: opts.imbalanceThreshold,
    vwapProximityPct: opts.vwapProximityPct,
  });

  return {
    symbol: quote.S,
    imbalance,
    mid: snapshot.mid,
    wall,
    topBid: snapshot.bids[0] ?? null,
    topAsk: snapshot.asks[0] ?? null,
    assessedAt: opts.assessedAt ?? Date.now(),
  };
}
