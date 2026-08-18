/**
 * Shared discovery scoring and filter helpers for V1 (post-session) and V2
 * (pre-market) screeners, plus intraday signal ranking.
 */

export interface GapSweetSpotParams {
  minGapPct: number;
  optimalGapPct: number;
  maxGapPct: number;
}

/**
 * Returns a 0–1 score for how attractive a gap is within configured bounds.
 * Peaks at optimalGapPct and decays linearly toward maxGapPct (parabolic gappers
 * score lower even when they pass the hard cap).
 */
export function computeGapSweetSpotScore(
  gapPct: number,
  params: GapSweetSpotParams,
): number {
  const { minGapPct, optimalGapPct, maxGapPct } = params;
  if (gapPct < minGapPct || gapPct > maxGapPct) return 0;
  if (optimalGapPct <= minGapPct) return 1;

  if (gapPct <= optimalGapPct) {
    return (gapPct - minGapPct) / (optimalGapPct - minGapPct);
  }

  if (maxGapPct <= optimalGapPct) return 0;
  return 1 - (gapPct - optimalGapPct) / (maxGapPct - optimalGapPct);
}

/**
 * V1 Core ranking: relative alpha is primary; RVOL confirms participation.
 * RVOL contribution is capped to avoid outlier volume dominating the sort.
 */
export function computeCoreDiscoveryScore(
  relativeReturn: number,
  relativeVolume: number,
  rvolCap = 5,
  rvolWeight = 0.25,
): number {
  const alphaScore = relativeReturn * 100;
  const rvolBonus = Math.min(relativeVolume, rvolCap) * rvolWeight;
  return alphaScore + rvolBonus;
}

/**
 * V2 Play-Maker ranking: gap sweet-spot × log-scaled dollar volume.
 * Favors liquid names gapping into the 4–8% zone over parabolic thin runners.
 */
export function computePremarketDiscoveryScore(
  gapPct: number,
  dollarVolume: number,
  gapParams: GapSweetSpotParams,
): number {
  const gapScore = computeGapSweetSpotScore(gapPct, gapParams);
  if (gapScore <= 0) return 0;

  const dvMillions = Math.max(dollarVolume, 1) / 1_000_000;
  const volumeScore = Math.log10(dvMillions + 1);
  return gapScore * volumeScore;
}

/**
 * Intraday momentum score for signal-queue priority.
 * Deviation above maxDeviationPct is capped so extended breakouts do not
 * outrank healthier setups closer to VWAP.
 */
export function computeMomentumScore(
  volume: number,
  deviationPct: number,
  maxDeviationPct: number,
): number {
  const cappedDeviation = Math.min(Math.max(deviationPct, 0), maxDeviationPct);
  return volume * cappedDeviation;
}
