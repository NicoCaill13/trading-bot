export interface ScoredSymbol {
  symbol: string;
  score: number;
}

/**
 * IBD-style weighted return. Weights sum to 1.
 * 3 months dominate, then 6, 9 and 12 months equally.
 * A name with at least `minSessions` but missing the longest leg is scored
 * on the legs it has, renormalised. Below `minSessions` returns null.
 */
export function momentumScore(
  closes: readonly number[],
  minSessions = 150,
): number | null {
  const legs: { sessions: number; weight: number }[] = [
    { sessions: 63, weight: 0.40 },
    { sessions: 126, weight: 0.20 },
    { sessions: 189, weight: 0.20 },
    { sessions: 252, weight: 0.20 },
  ];
  if (closes.length < minSessions) return null;

  let weighted = 0;
  let weightSum = 0;
  for (const leg of legs) {
    if (closes.length <= leg.sessions) continue;
    const past = closes[closes.length - 1 - leg.sessions];
    const last = closes[closes.length - 1];
    if (!(past > 0) || !(last > 0)) return null;
    weighted += leg.weight * (last / past - 1);
    weightSum += leg.weight;
  }
  if (weightSum <= 0) return null;
  return weighted / weightSum;
}

/**
 * Cross-sectional percentile in 1..99. The weakest name is 1, the strongest 99.
 * A single name is 99. Ties share the lower rank, then the scale is applied.
 */
export function assignRsRatings(scored: readonly ScoredSymbol[]): Map<string, number> {
  const ratings = new Map<string, number>();
  if (scored.length === 0) return ratings;

  const ordered = [...scored].sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return a.symbol < b.symbol ? -1 : 1;
  });

  const n = ordered.length;
  if (n === 1) {
    ratings.set(ordered[0].symbol, 99);
    return ratings;
  }

  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && ordered[j + 1].score === ordered[i].score) j++;
    const rank = i;
    const rating = Math.max(1, Math.min(99, Math.round(1 + (98 * rank) / (n - 1))));
    for (let k = i; k <= j; k++) ratings.set(ordered[k].symbol, rating);
    i = j + 1;
  }
  return ratings;
}

/** How far the close sits under the 52-week high, as a positive fraction. 0 = at the high. */
export function distanceFromHigh52w(
  highs: readonly number[],
  close: number,
  sessions = 252,
): number | null {
  if (highs.length < 1 || !(close > 0)) return null;
  const slice = highs.slice(-sessions);
  let high = -Infinity;
  for (const value of slice) {
    if (value > high) high = value;
  }
  if (!(high > 0)) return null;
  return Math.max(0, (high - close) / high);
}
