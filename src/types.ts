export type SignalTier = 'core' | 'satellite';

export type ExitReason =
  | 'target-5pct'
  | 'target-7pct'
  | 'stop-loss-initial'
  | 'trailing-stop'
  | 'eod-liquidation'
  | 'hard-close'
  | 'circuit-breaker'
  | 'unknown';

export type SpyTrend = 'bullish' | 'bearish' | 'neutral' | 'unknown';

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

/** Pullback state machine phase (V3). */
export type SignalState = 'TRACKING_PULLBACK' | 'TRIGGERED';

export interface PullbackTracker {
  state: SignalState;
  localHigh: number;
  prevClose: number;
  vwapAtDetection: number;
  tier: SignalTier;
  score: number;
  avgVolume: number;
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

export interface TradeRecord {
  // Pre-trade context (Screener Data)
  symbol: string;
  origin: SignalOrigin;
  alpha_vs_spy: number | null;
  gap_percentage: number | null;
  relative_volume: number | null;

  // Entry & Technical Indicators
  entry_time: string;
  entry_price: number;
  qty: number;
  vwap_at_entry: number;
  ema9_at_entry: number | null;
  sma20_at_entry: number | null;
  distance_to_sma20_percent: number | null;
  spy_trend_5m: SpyTrend;

  // Partial exit — populated when a scale-out fires (50% sold at target)
  scale_out_price: number | null;
  scale_out_qty: number | null;
  scale_out_reason: 'target-5pct' | 'target-7pct' | null;

  // Final exit metrics (null until fully closed)
  exit_time: string | null;
  exit_price: number | null;
  exit_reason: ExitReason | null;
  // Dollar-weighted PnL across both scale-out and final exit legs
  net_pnl_dollars: number | null;
  net_pnl_percentage: number | null;
  mfe_percent: number | null;
  mae_percent: number | null;
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
