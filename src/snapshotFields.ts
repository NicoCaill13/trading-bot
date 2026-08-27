/**
 * Alpaca snapshot field extractors — shared by the 09:15 pool and the 09:31 scanner.
 */

import type { AlpacaSnapshot } from '@alpacahq/alpaca-trade-api';

export function resolveSnapshotTicker(snap: AlpacaSnapshot): string | null {
  return (
    snap.Symbol ??
    (snap as { symbol?: string }).symbol ??
    snap.MinuteBar?.Symbol ??
    snap.DailyBar?.Symbol ??
    snap.PrevDailyBar?.Symbol ??
    null
  );
}

export function extractLastPrint(snap: AlpacaSnapshot): number | null {
  const trade = snap.LatestTrade?.Price;
  if (trade !== undefined && trade > 0) return trade;
  const minuteClose = snap.MinuteBar?.ClosePrice;
  if (minuteClose !== undefined && minuteClose > 0) return minuteClose;
  const dailyClose = snap.DailyBar?.ClosePrice;
  if (dailyClose !== undefined && dailyClose > 0) return dailyClose;
  return null;
}

export function extractPreviousClose(snap: AlpacaSnapshot): number | null {
  const prev = snap.PrevDailyBar?.ClosePrice;
  if (prev !== undefined && prev > 0) return prev;
  return null;
}

export function extractPreviousVolume(snap: AlpacaSnapshot): number {
  const vol = snap.PrevDailyBar?.Volume;
  return vol !== undefined && vol > 0 ? vol : 0;
}

export function extractSessionOpen(snap: AlpacaSnapshot): number | null {
  const open = snap.DailyBar?.OpenPrice;
  if (open !== undefined && open > 0) return open;
  return null;
}

export function extractSessionVolume(snap: AlpacaSnapshot): number {
  const vol = snap.DailyBar?.Volume;
  return vol !== undefined && vol > 0 ? vol : 0;
}
