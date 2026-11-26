/**
 * Shared types for the swing study radar.
 *
 * TradeRecord and the small enums it depends on stay so the expectancy
 * module (and its tests) keep compiling. The live bot no longer writes trades.
 */

export type SignalOrigin = 'V1_CORE' | 'V2_PLAYMAKER';
export type SpyTrend = 'bullish' | 'bearish' | 'neutral' | 'unknown';
export type FibLevelName = '23.6' | '38.2' | '50.0' | '61.8' | '78.6';
export type ExitReason = string;

export type NewsSentiment = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface WatchlistSymbol {
  symbol: string;
  origin: SignalOrigin;
  source?: 'core' | 'satellite';
  sentiment?: NewsSentiment;
  catalystScore?: number;
  catalystHeadline?: string;
}

export interface Watchlist {
  generatedAt: string;
  tradingDay?: string;
  benchmarkReturn: number | null;
  universeSize: number;
  liquidFiltered: number;
  symbols: WatchlistSymbol[];
}

export interface TradeRecord {
  symbol: string;
  origin: SignalOrigin;
  alpha_vs_spy: number | null;
  gap_percentage: number | null;
  relative_volume: number | null;
  entry_time: string;
  entry_price: number;
  qty: number;
  vwap_at_entry: number;
  ema9_at_entry: number | null;
  sma20_at_entry: number | null;
  distance_to_sma20_percent: number | null;
  spy_trend_5m: SpyTrend;
  scale_out_price: number | null;
  scale_out_qty: number | null;
  scale_out_reason: 'target-5pct' | 'target-7pct' | 'target-atr' | null;
  fib_level_at_entry: number | null;
  fib_level_name_at_entry: FibLevelName | null;
  exit_time: string | null;
  exit_price: number | null;
  exit_reason: ExitReason | null;
  net_pnl_dollars: number | null;
  net_pnl_percentage: number | null;
  mfe_percent: number | null;
  mae_percent: number | null;
  equity_at_entry: number | null;
  risk_dollars_at_entry: number | null;
  pnl_r: number | null;
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

export type SessionPhase = 'idle' | 'scanning' | 'non_trading_day';

export interface HeartbeatSnapshot {
  writtenAt: string;
  startedAt: string;
  pid: number;
  sessionPhase: SessionPhase;
  sessionPhaseSince: string;
  tradingDay: boolean;
  lastScanAt: string | null;
  reportTradingDay: string | null;
  candidateCount: number;
}

export type WatchdogFindingCode = 'HEARTBEAT_MISSING' | 'HEARTBEAT_STALE' | 'REPORT_STALE';

export interface WatchdogFinding {
  code: WatchdogFindingCode;
  message: string;
}

export interface WatchdogThresholds {
  heartbeatStaleMs: number;
  reportMaxAgeHours: number;
  /** Minutes since midnight EST after which today's report is required. */
  reportDueMinute: number;
}

/** Daily bar used by every pure detector. Oldest to newest. */
export interface PriceBar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Daily bar tagged with its NY session day (YYYY-MM-DD) for weekly aggregation. */
export interface DatedDailyBar extends PriceBar {
  day: string;
}

/** ISO-week OHLCV bar built from split-adjusted daily sessions. */
export interface WeeklyBar extends PriceBar {
  weekStart: string;
  weekEnd: string;
  sessions: number;
}

export type WeinsteinStage = 'STAGE_1' | 'STAGE_2' | 'STAGE_3' | 'STAGE_4';

export interface PriceZone {
  price: number;
  touches: number;
}

export interface WeeklyAssessment {
  stage: WeinsteinStage;
  close: number;
  sma10w: number;
  sma30w: number;
  sma40w: number | null;
  sma30wSlopePct: number;
  maAligned: boolean;
  tightWeeksCount: number;
  supportZones: PriceZone[];
  resistanceZones: PriceZone[];
}

export interface WeeklyClearance {
  nearestSupport: PriceZone | null;
  nearestResistance: PriceZone | null;
  blueSky: boolean;
  roomToResistancePct: number | null;
  roomToResistanceR: number | null;
  nearSma10wSupport: boolean;
}

export type MarketRegimeStatus =
  | 'CONFIRMED_UPTREND'
  | 'UPTREND_UNDER_PRESSURE'
  | 'CORRECTION';

export type SetupState = 'FORMING_AT_PIVOT' | 'FRESH_BREAKOUT';

export type SwingPattern =
  | 'VCP'
  | 'CUP_HANDLE'
  | 'KULLAMAGI_FLAG'
  | 'FLAT_BASE'
  | 'WYCKOFF_SPRING'
  | 'ETEI'
  | 'EPISODIC_PIVOT';

export type StudyGrade = 'A+' | 'A' | 'B';

export interface SwingSetup {
  pattern: SwingPattern;
  state: SetupState;
  pivot: number;
  stop: number;
  rvol: number | null;
  thesis: string;
  /** Average volume of the contraction / average volume before it. Lower is drier. */
  volumeDryUpRatio: number | null;
  contractionDepths: number[];
}

export interface IndexRegime {
  symbol: string;
  status: MarketRegimeStatus;
  close: number;
  sma50: number;
  sma200: number;
  sma50Rising: boolean;
  distributionDays: number;
  recommendedExposurePct: 0 | 50 | 100;
  weeklyStage?: WeinsteinStage | null;
  sma10w?: number | null;
  sma30w?: number | null;
}

export interface FunnelStats {
  universe: number;
  liquid: number;
  adrPass: number;
  templatePass: number;
  weeklyTrendPass: number;
  chartSetups: number;
  episodicCandidates: number;
  episodicPass: number;
  rejectedOverheadSupply: number;
  rejectedWideRisk: number;
  published: number;
}

export interface StudyCard {
  symbol: string;
  exchange: string;
  pattern: SwingPattern;
  state: SetupState;
  grade: StudyGrade;
  masterScore: number;
  close: number;
  pivot: number;
  stop: number;
  riskPct: number;
  entry: number;
  target2r: number;
  target3r: number;
  referenceQty: number;
  rsRating: number | null;
  adrPct: number;
  rvol: number | null;
  distanceFromHigh52wPct: number | null;
  ema10: number | null;
  ema20: number | null;
  sma50: number | null;
  weeklyStage: WeinsteinStage | null;
  sma10w: number | null;
  sma30w: number | null;
  sma40w: number | null;
  weeklyMaAligned: boolean;
  tightWeeksCount: number;
  weeklySupport: number | null;
  weeklyResistance: number | null;
  weeklyBlueSky: boolean;
  roomToResistanceR: number | null;
  thesis: string;
  catalystHeadline: string | null;
  tradingViewUrl: string;
}

export interface SwingStudyReport {
  generatedAt: string;
  tradingDay: string;
  benchmarkReturn: number | null;
  universeSize: number;
  liquidFiltered: number;
  symbols: WatchlistSymbol[];
  regimes: IndexRegime[];
  combinedStatus: MarketRegimeStatus;
  recommendedExposurePct: 0 | 50 | 100;
  funnel: FunnelStats;
  cards: StudyCard[];
}
