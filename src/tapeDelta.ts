/**
 * Signed-print helpers for the Opening Drive tape gate.
 *
 * Lee-Ready vs the last mid when a quote exists; tick test vs the previous
 * print otherwise. Snapshot imbalance is not used — that is not order-flow.
 */

export type TapeSide = 1 | -1 | 0;

export interface TapeBucket {
  buyVolume: number;
  sellVolume: number;
}

/** Floor an ISO timestamp to the UTC minute epoch. Null on unparseable input. */
export function minuteEpoch(timestamp: string): number | null {
  const t = Date.parse(timestamp);
  if (!Number.isFinite(t)) return null;
  return Math.floor(t / 60_000);
}

/**
 * Classify a print: above mid = buy, below = sell, at mid (or no mid) = tick test.
 * Unclassifiable prints return 0 and must not enter the delta.
 */
export function signPrint(
  price: number,
  mid: number | null,
  prevPrice: number | null,
): TapeSide {
  if (!(price > 0)) return 0;

  if (mid !== null && mid > 0) {
    if (price > mid) return 1;
    if (price < mid) return -1;
  }

  if (prevPrice !== null && prevPrice > 0) {
    if (price > prevPrice) return 1;
    if (price < prevPrice) return -1;
  }

  return 0;
}

/** (buy − sell) / (buy + sell). Null when nothing classified. */
export function computeTapeDelta(buyVolume: number, sellVolume: number): number | null {
  const total = buyVolume + sellVolume;
  if (total <= 0) return null;
  return (buyVolume - sellVolume) / total;
}

export function emptyTapeBucket(): TapeBucket {
  return { buyVolume: 0, sellVolume: 0 };
}

export function addSignedVolume(
  bucket: TapeBucket,
  side: TapeSide,
  size: number,
): TapeBucket {
  if (size <= 0 || side === 0) return bucket;
  if (side === 1) return { buyVolume: bucket.buyVolume + size, sellVolume: bucket.sellVolume };
  return { buyVolume: bucket.buyVolume, sellVolume: bucket.sellVolume + size };
}
