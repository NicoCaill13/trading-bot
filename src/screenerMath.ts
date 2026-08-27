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

/** Inclusive price band [minPrice, maxPrice]. */
export function passesPriceBand(
  price: number,
  minPrice: number,
  maxPrice: number,
): boolean {
  return price >= minPrice && price <= maxPrice;
}

/**
 * Premarket pair: both the last print and yesterday's close must sit in the
 * band. A $8 print on a $0.20 close is a corporate-action / bad tick, not a
 * Hyper-Growth name (GRML 25/08).
 */
export function passesPremarketPricePair(
  preMarketPrice: number,
  previousClose: number,
  minPrice: number,
  maxPrice: number,
): boolean {
  return (
    passesPriceBand(preMarketPrice, minPrice, maxPrice) &&
    passesPriceBand(previousClose, minPrice, maxPrice)
  );
}

/** Higher pre-market dollar volume first; gap is the tie-break. */
export function comparePremarketRank(
  a: { dollarVolume: number; gapPct: number },
  b: { dollarVolume: number; gapPct: number },
): number {
  const byDollarVolume = b.dollarVolume - a.dollarVolume;
  if (Math.abs(byDollarVolume) > 1e-9) return byDollarVolume;
  return b.gapPct - a.gapPct;
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

/**
 * Alpaca lists ETFs under `us_equity` with no `attributes: ["etf"]` flag.
 * Opening Drive is stock-only — names are the only reliable discriminator.
 * Empty name fails closed so an unnamed payload never reaches the watchlist.
 */
const ETF_VEHICLE_RE = /\b(?:ETF|ETN|ETP|ETMF)s?\b/i;
const ETF_ISSUER_OR_SHARE_CLASS_RE =
  /\b(?:ProShares|Direxion|iShares|SPDR|UltraPro|UltraShort)\b/i;
const ETF_LEVERAGED_DAILY_RE =
  /\bDaily\b.+\b(?:Bull|Bear)\b|\b(?:Bull|Bear)\b.+\b\d+X\b/i;
const ETF_TRUST_SERIES_RE = /\bTrust,\s*Series\b/i;

export function isEtfLikeProduct(params: {
  name?: string | null;
  attributes?: readonly string[] | null;
}): boolean {
  const attributes = params.attributes ?? [];
  if (attributes.some(a => a.trim().toLowerCase() === 'etf')) {
    return true;
  }

  const name = (params.name ?? '').trim();
  if (name.length === 0) return true;

  return (
    ETF_VEHICLE_RE.test(name) ||
    ETF_ISSUER_OR_SHARE_CLASS_RE.test(name) ||
    ETF_LEVERAGED_DAILY_RE.test(name) ||
    ETF_TRUST_SERIES_RE.test(name)
  );
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

/** (last − sessionOpen) / sessionOpen. Null when the open is not usable. */
export function computeOpeningExtensionPct(
  last: number,
  sessionOpen: number,
): number | null {
  if (!(last > 0) || !(sessionOpen > 0)) return null;
  return (last - sessionOpen) / sessionOpen;
}

export interface OpeningExtensionCandidate {
  last: number;
  sessionOpen: number;
  previousClose: number;
  rthDollarVolume: number;
}

export interface OpeningExtensionGateOpts {
  minPrice: number;
  maxPrice: number;
  minExtensionPct: number;
  minRthDollarVolume: number;
}

/**
 * Long-only opening-extension gates: last above the session open, minimum
 * extension, price band on last AND previous close, RTH dollar-volume floor.
 */
export function passesOpeningExtensionGates(
  c: OpeningExtensionCandidate,
  opts: OpeningExtensionGateOpts,
): boolean {
  const extension = computeOpeningExtensionPct(c.last, c.sessionOpen);
  if (extension === null) return false;
  if (!(c.last > c.sessionOpen)) return false;
  if (extension < opts.minExtensionPct) return false;
  if (!passesPremarketPricePair(c.last, c.previousClose, opts.minPrice, opts.maxPrice)) {
    return false;
  }
  return c.rthDollarVolume >= opts.minRthDollarVolume;
}

export interface OpeningExtensionRank {
  extensionPct: number;
  rthDollarVolume: number;
}

/** Extension from the open first; RTH dollar volume is the tie-break. */
export function compareOpeningExtensionRank(
  a: OpeningExtensionRank,
  b: OpeningExtensionRank,
): number {
  const byExtension = b.extensionPct - a.extensionPct;
  if (Math.abs(byExtension) > 1e-12) return byExtension;
  return b.rthDollarVolume - a.rthDollarVolume;
}

