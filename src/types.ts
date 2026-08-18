export type SignalTier = 'core' | 'satellite';

// ---------------------------------------------------------------------------
// Fibonacci retracement types
// ---------------------------------------------------------------------------

export type FibLevelName = '23.6' | '38.2' | '50.0' | '61.8' | '78.6';

export interface FibLevels {
  swingLow: number;
  swingHigh: number;
  level_236: number;
  level_382: number;
  level_500: number;
  level_618: number;
  level_786: number;
}

export interface FibProximity {
  nearestLevel: number;
  nearestName: FibLevelName;
  distancePct: number;
  isNearSupport: boolean;
}

export type ExitReason =
  | 'target-5pct'
  | 'target-7pct'
  | 'target-atr'
  | 'stop-loss-initial'
  | 'trailing-stop'
  | 'rsi-overbought-exit'
  | 'volume-exhaustion-trailing'
  | 'time-stop'
  | 'eod-liquidation'
  | 'hard-close'
  | 'circuit-breaker'
  | 'daily-drawdown-kill'
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

/** Pullback state machine phase (V3 Satellite tick-up; Core stays on TRACKING until 5m confirm). */
export type SignalState = 'TRACKING_PULLBACK' | 'TRIGGERED';

export interface PullbackTracker {
  state: SignalState;
  localHigh: number;
  prevClose: number;
  vwapAtDetection: number;
  tier: SignalTier;
  score: number;
  avgVolume: number;
  fibLevels: FibLevels | null;
  /** Volumes of N bars ending at VWAP breakout (dry-up impulse baseline). */
  impulseVolumes: number[];
  /** Volumes of 5m bars after breakout while tracking pullback. */
  pullbackVolumes: number[];
}

export interface PendingSignal {
  symbol: string;
  tier: SignalTier;
  score: number;
  barData: BarData;
  vwap: number;
  avgVolume: number;
  fibLevels: FibLevels | null;
}

/** Motifs de rejet liquidité / univers (logs screener). */
export type LiquidityRejectReason =
  | 'exchange'
  | 'price'
  | 'dollar_volume'
  | 'no_bar'
  | 'missing_ticker'
  | 'adr'
  | 'float'
  | 'insufficient_history'
  | 'premarket_volume'
  | 'gap'
  | 'missing_price';

/** Daily reversal structures (spec §3.A). */
export type ReversalPattern = 'ETEI' | 'DOUBLE_BOTTOM_SPRING';

export interface PivotPoint {
  index: number;
  price: number;
  volume: number;
}

export interface ReversalPatternSignal {
  pattern: ReversalPattern;
  neckline?: number;
  support?: number;
  breakoutRvol?: number;
  reclaimRvol?: number;
  pivots: PivotPoint[];
}

/** Daily continuation structures (spec §3.B). */
export type ContinuationPattern = 'BULL_FLAG' | 'CUP_HANDLE' | 'FLAT_BASE';

export interface ContinuationPatternSignal {
  pattern: ContinuationPattern;
  impulsePct?: number;
  flagHigh?: number;
  rim?: number;
  atrCompressionRatio?: number;
  breakoutRvol?: number;
  pivots: PivotPoint[];
}

/** Lexicon news headline sentiment for the catalyst gate (#21). */
export type NewsSentiment = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

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
  /** Lexicon sentiment of the strongest recent catalyst headline. */
  sentiment?: NewsSentiment;
  /** Headline that armed the bullish catalyst gate (when present). */
  catalystHeadline?: string;
  /** Average Daily Range % over screener.adrLookbackDays (Core). */
  adrPct?: number;
  /** Free float shares when float filter provider is available. */
  floatShares?: number;
  /** Alpaca asset exchange (e.g. NYSE, NASDAQ). */
  exchange?: string;
  /** Weinstein Phase 2 — SMA 150 daily. */
  sma150?: number;
  /** Weinstein Phase 2 — SMA 200 daily. */
  sma200?: number;
  /** SMA150[t] - SMA150[t-8w]; non-negative required. */
  sma150Slope?: number;
  /** Soft annotate: ETEI or Spring when detected post-Weinstein. */
  reversalPattern?: ReversalPattern;
  reversalDetail?: ReversalPatternSignal;
  /** Soft annotate: Bull Flag / Cup&Handle / Flat Base post-Weinstein. */
  continuationPattern?: ContinuationPattern;
  continuationDetail?: ContinuationPatternSignal;
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
  takeProfitPrice: number;
  atr: number;
}

export interface EnteredSymbolEntry {
  symbol: string;
  tier: SignalTier;
}

export interface AdaptiveFilters {
  maxVwapEntryDistancePct: number;
  maxGapPctForEntry: number | null;
  blockV1WhenSpyBearish: boolean;
  atrStopTooWideWarning: boolean;
  computedAt: string | null;
}

// ---------------------------------------------------------------------------
// Liveness contract — written by the bot, read by the standalone watchdog.
// This is the only coupling between the two processes: no shared config, no
// shared business logic, no socket.
// ---------------------------------------------------------------------------

export type SessionPhase = 'pre_open' | 'session' | 'post_close' | 'non_trading_day';

export type WsState = 'disabled' | 'disconnected' | 'connecting' | 'authenticated';

export interface HeartbeatSnapshot {
  writtenAt: string;
  startedAt: string;
  pid: number;
  sessionPhase: SessionPhase;
  /** Instant the current phase was first observed — grace period for staleness rules. */
  sessionPhaseSince: string;
  tradingDay: boolean;
  tradingHalted: boolean;
  wsState: WsState;
  lastBarAt: string | null;
  monitoredSymbols: number;
  /** Broker-sourced count — the in-process map is not authoritative after the close. */
  openPositions: number;
  openPositionsCheckedAt: string | null;
  watchlistGeneratedAt: string | null;
}

export type WatchdogFindingCode =
  | 'HEARTBEAT_MISSING'
  | 'HEARTBEAT_STALE'
  | 'MARKET_DATA_STALE'
  | 'WATCHLIST_STALE'
  | 'POSITIONS_OPEN_AFTER_CLOSE';

export interface WatchdogFinding {
  code: WatchdogFindingCode;
  message: string;
}

export interface WatchdogThresholds {
  heartbeatStaleMs: number;
  marketDataStaleMs: number;
  watchlistMaxAgeHours: number;
  /** EST wall-clock time after which any open position is considered overnight risk. */
  openPositionCheckHour: number;
  openPositionCheckMinute: number;
  /** Beyond this age the broker position count is too old to raise an overnight alert. */
  openPositionDataMaxAgeMs: number;
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
  scale_out_reason: 'target-5pct' | 'target-7pct' | 'target-atr' | null;

  // Fibonacci context at entry — nearest retracement level and its name
  fib_level_at_entry: number | null;
  fib_level_name_at_entry: FibLevelName | null;

  // Final exit metrics (null until fully closed)
  exit_time: string | null;
  exit_price: number | null;
  exit_reason: ExitReason | null;
  // Dollar-weighted PnL across both scale-out and final exit legs
  net_pnl_dollars: number | null;
  net_pnl_percentage: number | null;
  mfe_percent: number | null;
  mae_percent: number | null;

  // Risk in R-multiples (V7 expectancy) — null on legacy journal rows
  equity_at_entry: number | null;
  risk_dollars_at_entry: number | null;
  pnl_r: number | null;
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

/** Alpaca IEX quote (top-of-book). Not full multi-level L2. */
export interface WsQuoteMessage {
  T: 'q';
  S: string;
  /** Bid price */
  bp: number;
  /** Bid size */
  bs: number;
  /** Ask price */
  ap: number;
  /** Ask size */
  as: number;
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
  | WsQuoteMessage
  | WsSuccessMessage
  | WsErrorMessage
  | { T: string };

/** Backpressure policy when the market-data queue is full. */
export type BusDropPolicy = 'drop_oldest' | 'drop_newest';

/**
 * Typed market-data bus events (WS producer → strategy consumer).
 */
export type MarketDataEvent =
  | {
      kind: 'bar_1m';
      receivedAt: number;
      bar: WsBarMessage;
    }
  | {
      kind: 'quote';
      receivedAt: number;
      quote: WsQuoteMessage;
    };

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBookSnapshot {
  symbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  mid: number | null;
  timestamp: string;
}

export interface ImbalanceSignal {
  symbol: string;
  imbalance: number | null;
  mid: number | null;
  wall: boolean;
  topBid: OrderBookLevel | null;
  topAsk: OrderBookLevel | null;
  assessedAt: number;
}

/** Morning market regime label (heuristic / future ONNX classifier). */
export type MarketRegime = 'TRENDING' | 'CHOPPY' | 'UNKNOWN';

export interface RegimeFeatures {
  vixLast: number | null;
  spyAdr14d: number | null;
  /** Proxy: sum of SPY+QQQ 1Min share volume in EST [04:00, 09:30). */
  premarketGlobalVolumeProxy: number | null;
}

export interface RegimeSnapshot {
  regime: MarketRegime;
  features: RegimeFeatures;
  effectiveRiskPerTradePct: number;
  minRiskRewardRatio: number;
  predictedAt: string;
  /** False when REGIME_MODEL_SHADOW or model disabled — sizing stays nominal. */
  applied: boolean;
}

/**
 * Injected risk/TP scaler consumed by riskManager (DIP — no broker coupling).
 */
export interface RegimeRiskScaler {
  getEffectiveRiskPerTradePct(): number;
  getMinRiskRewardRatio(): number;
  getRegime(): MarketRegime;
}
