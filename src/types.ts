export type SignalTier = 'core' | 'satellite';

/** Strategy lineage tag persisted on the daily watchlist. */
export type SignalOrigin = 'V1_CORE' | 'V2_PLAYMAKER';

/** Portfolio bucket origin for capital allocation (Core / Satellite). */
export type PortfolioOrigin = SignalTier;

export function resolveSymbolTier(entry: Pick<WatchlistSymbol, 'origin' | 'source'>): SignalTier {
  if (entry.origin === 'V2_PLAYMAKER') return 'satellite';
  if (entry.origin === 'V1_CORE') return 'core';
  return entry.source === 'satellite' ? 'satellite' : 'core';
}

export interface PortfolioAllocation {
  origin: PortfolioOrigin;
  totalCapital: number;
  maxCapital: number;
  deployed: number;
  available: number;
  canOpen: boolean;
}

export interface BarData {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: string;
}

export interface SessionBarData {
  vwap: number;
  high: number;
  lastBarLow: number;
}

export interface PendingSignal {
  symbol: string;
  tier: SignalTier;
  score: number;
  barData: BarData;
  vwap: number;
  avgVolume: number;
}

export interface WatchlistSymbol {
  symbol: string;
  origin: SignalOrigin;
  /** @deprecated Use `origin` — kept for legacy watchlist files. */
  source?: SignalTier;
  relativeReturn?: number;
  symbolReturn?: number;
  gapUp?: number;
  gapHeld?: boolean;
  relativeVolume?: number;
  dollarVolume?: number;
  lastClose?: number;
  lastOpen?: number;
  preMarketGapPct?: number;
  catalystScore?: number;
}

export interface Watchlist {
  generatedAt: string;
  benchmarkReturn: number | null;
  universeSize: number;
  liquidFiltered: number;
  symbols: WatchlistSymbol[];
}

export interface PremarketWatchlist {
  generatedAt: string;
  universeSize: number;
  liquidFiltered: number;
  symbols: WatchlistSymbol[];
}

export interface OrbState {
  high: number;
  low: number;
  barsCollected: number;
  triggered: boolean;
}

export interface PositionSizeResult {
  qty: number;
  stopLossPrice: number;
  atr: number;
}

export interface EnteredSymbolEntry {
  symbol: string;
  tier: SignalTier;
}

export interface DailyReportData {
  startEquity: number;
  endEquity: number;
  tradesEntered: number;
  circuitBreakerFired: boolean;
  symbols: string[];
}

export interface SessionState {
  date: string;
  enteredSymbols: EnteredSymbolEntry[] | string[];
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface DiscordField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface WsBarMessage {
  T: 'b';
  S: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  t: string;
}

export interface WsSuccessMessage {
  T: 'success';
  msg: string;
}

export interface WsErrorMessage {
  T: 'error';
  code: number;
  msg: string;
}

export type WsMessage =
  | WsBarMessage
  | WsSuccessMessage
  | WsErrorMessage
  | { T: string };
