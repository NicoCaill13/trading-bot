/**
 * Pure screener liquidity / ADR helpers — no I/O, unit-testable.
 */

export interface OhlcBar {
  high: number;
  low: number;
  close: number;
}

export interface VolumeBar {
  volume: number;
}

/**
 * ADR% over the last `lookbackDays` bars:
 * mean(((high - low) / close) * 100). Returns null if fewer than lookbackDays
 * bars with close > 0.
 */
export function computeAdrPct(
  bars: readonly OhlcBar[],
  lookbackDays: number,
): number | null {
  if (lookbackDays < 1 || bars.length < lookbackDays) return null;

  const slice = bars.slice(-lookbackDays);
  let sum = 0;
  for (const bar of slice) {
    if (bar.close <= 0) return null;
    sum += ((bar.high - bar.low) / bar.close) * 100;
  }
  return sum / lookbackDays;
}

/** Spec: reject when ADR <= minAdrPct. */
export function passesAdrGate(adrPct: number, minAdrPct: number): boolean {
  return adrPct > minAdrPct;
}

export function passesClosePrice(close: number, minPrice: number): boolean {
  return close >= minPrice;
}

export function passesDollarVolume(
  close: number,
  volume: number,
  minDollarVolume: number,
): boolean {
  return close * volume >= minDollarVolume;
}

/** Inclusive float band [minFloat, maxFloat]. */
export function passesFloatGate(
  floatShares: number,
  minFloat: number,
  maxFloat: number,
): boolean {
  return floatShares >= minFloat && floatShares <= maxFloat;
}

export function isAllowedExchange(
  exchange: string,
  allowed: readonly string[],
): boolean {
  const normalized = exchange.trim().toUpperCase();
  return allowed.some(a => a.toUpperCase() === normalized);
}

export function sumShareVolume(bars: readonly VolumeBar[]): number {
  return bars.reduce((sum, b) => sum + (b.volume > 0 ? b.volume : 0), 0);
}

/**
 * Watchlist rank after the hard universe gates (liquidity, ADR, Weinstein).
 * Alpha vs SPY first; RVOL then gap as tie-breakers — never as rejects.
 */
export function compareWatchlistRank(
  a: { relativeReturn?: number; relativeVolume?: number; gapUp?: number },
  b: { relativeReturn?: number; relativeVolume?: number; gapUp?: number },
): number {
  const alpha = (b.relativeReturn ?? 0) - (a.relativeReturn ?? 0);
  if (Math.abs(alpha) > 1e-12) return alpha;
  const rvol = (b.relativeVolume ?? 0) - (a.relativeVolume ?? 0);
  if (Math.abs(rvol) > 1e-12) return rvol;
  return (b.gapUp ?? 0) - (a.gapUp ?? 0);
}

