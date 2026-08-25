// Importing './env' loads the environment file — see the note in that module.
import { parseFloatEnv, parseIntEnv, parseStringEnv, requireEnv } from './env';
import { computeTrailLockedPct, isProfitLockingTrail, minProfitLockingTriggerPct } from './exitPredicates';

function parseFeed(envKey: string, raw: string | undefined, fallback: 'iex' | 'sip'): 'iex' | 'sip' {
  const value = (raw ?? fallback).trim().toLowerCase();
  if (value === 'iex' || value === 'sip') return value;
  throw new Error(`[SYSTEM] ${envKey} must be iex|sip: "${raw ?? ''}"`);
}

function parseBusDropPolicy(raw: string | undefined): 'drop_oldest' | 'drop_newest' {
  const value = (raw ?? 'drop_oldest').trim().toLowerCase();
  if (value === 'drop_oldest' || value === 'drop_newest') return value;
  throw new Error(
    `[SYSTEM] BUS_DROP_POLICY must be drop_oldest|drop_newest: "${raw ?? ''}"`,
  );
}

const config = {
  alpaca: {
    keyId: requireEnv('ALPACA_KEY_ID'),
    secretKey: requireEnv('ALPACA_SECRET_KEY'),
    baseUrl: process.env.ALPACA_BASE_URL ?? 'https://paper-api.alpaca.markets',
    dataUrl: process.env.ALPACA_DATA_URL ?? 'https://data.alpaca.markets',
    /**
     * Historical REST (screener, regime, overnight studies). SIP sees the full
     * tape; on Basic it is delayed 15 minutes — fine for completed sessions,
     * not for live bars. IEX historical under-counts pre-market micro-caps.
     */
    dataFeed: parseFeed('ALPACA_DATA_FEED', process.env.ALPACA_DATA_FEED, 'sip'),
    /**
     * Live tape: WebSocket plus REST that must be current (hydration, ATR,
     * SPY trend). IEX is real-time on Basic and is what the bot used in
     * production. `v2/sip` needs Algo Trader Plus; without it the stream
     * falls back to IEX rather than dying.
     */
    streamFeed: parseFeed('ALPACA_STREAM_FEED', process.env.ALPACA_STREAM_FEED, 'iex'),
    /**
     * A non-realtime plan refuses any SIP window ending inside the last 15
     * minutes, and refuses the whole request rather than truncating it. One
     * extra minute of margin absorbs clock skew.
     */
    sipDelayMs: parseIntEnv('SIP_DELAY_MS', 16 * 60_000),
    paper: true as const,
  },

  risk: {
    // T+1 cash: leftover settled cash after ticket #1 is the only fuel for #2.
    maxPositions: parseIntEnv('MAX_POSITIONS', 2),
    // Capital allocated to this strategy. Sizing and the notional cap use
    // min(account equity, this) so an over-funded paper account reproduces the
    // fills and share rounding of the live account. 0 = use the whole account.
    strategyCapitalUsd: parseFloatEnv('STRATEGY_CAPITAL_USD', 0),
    // Cash-account notional ceiling: qty * entry <= equity * maxPositionPct (no leverage).
    maxPositionPct: parseFloatEnv('MAX_POSITION_PCT', 0.55),
    riskPerTradePct: parseFloatEnv('RISK_PER_TRADE_PCT', 0.20),
    minRiskRewardRatio: parseFloatEnv('MIN_RISK_REWARD_RATIO', 2),
    // Percent trail: arm inside the Opening Drive MFE body (~4–10%, median ~8%),
    // not in the +20% tail. 8% / 4% locks +3.68% on the ticket; a 12% trail
    // cannot lock a profit unless the trigger exceeds 13.6% — above typical MFE.
    atrTrailTriggerPct: parseFloatEnv('ATR_TRAIL_TRIGGER_PCT', 0.08),
    atrTrailMultiplier: parseFloatEnv('ATR_TRAIL_MULTIPLIER', 4),
    timeStopMinutes: parseIntEnv('TIME_STOP_MINUTES', 20),
    atrStopMultiplier: parseFloatEnv('ATR_STOP_MULTIPLIER', 1.5),
    hardStopFloorPct: parseFloatEnv('HARD_STOP_FLOOR_PCT', 0.025),
    // Kept for legacy callers / old .env. Scale-out and bracket TP are off.
    scaleOutTargetPct: parseFloatEnv(
      'SCALE_OUT_TARGET_PCT',
      parseFloatEnv('SCALE_OUT_TARGET_PCT_CORE', 0.30),
    ),
    trailingStopPct: parseFloatEnv('TRAILING_STOP_PCT', 0.04),
    takeProfitEnabled: process.env.TAKE_PROFIT_ENABLED === 'true',
    scaleOutEnabled: process.env.SCALE_OUT_ENABLED === 'true',
    smartExitsEnabled: process.env.SMART_EXITS_ENABLED === 'true',
    usePercentTrail: process.env.USE_PERCENT_TRAIL !== 'false',
    scaleOutSettlementDelayMs: parseIntEnv('SCALE_OUT_SETTLEMENT_DELAY_MS', 3000),
    eodTightTrailPct: parseFloatEnv('EOD_TIGHT_TRAIL_PCT', 0.005),
    // 0 disables the daily profit circuit breaker (drawdown kill-switch stays).
    dailyProfitTargetPct: parseFloatEnv('DAILY_PROFIT_TARGET_PCT', 0),
    dailyDrawdownLimitDollars: parseFloatEnv('DAILY_DRAWDOWN_LIMIT_DOLLARS', -40),
    dailyDrawdownLimitPct: parseFloatEnv('DAILY_DRAWDOWN_LIMIT_PCT', -0.20),
    atrTakeProfitMultiplier: parseFloatEnv('ATR_TP_MULTIPLIER', 1.5),
    atrStopMultiplier5m: parseFloatEnv('ATR_STOP_MULTIPLIER_5M', 1.0),
    smartExitMinPnlPct: parseFloatEnv('SMART_EXIT_MIN_PNL_PCT', 0.01),
    smartExitRsiPeriod: parseIntEnv('SMART_EXIT_RSI_PERIOD', 14),
    smartExitRsiThreshold: parseFloatEnv('SMART_EXIT_RSI_THRESHOLD', 80),
    volumeExhaustionMinPnlPct: parseFloatEnv('VOLUME_EXHAUSTION_MIN_PNL_PCT', 0.005),
    volumeExhaustionVmaRatio: parseFloatEnv('VOLUME_EXHAUSTION_VMA_RATIO', 0.5),
    volumeExhaustionConsecutiveBars: parseIntEnv('VOLUME_EXHAUSTION_CONSECUTIVE_BARS', 2),
    volumeExhaustionTrailPct: parseFloatEnv('VOLUME_EXHAUSTION_TRAIL_PCT', 0.002),
    timeDecayTpHalveStartHour: parseIntEnv('TIME_DECAY_TP_HALVE_START_HOUR', 13),
    timeDecayTpHalveEndHour: parseIntEnv('TIME_DECAY_TP_HALVE_END_HOUR', 14),
    timeDecayTpHalveEndMinute: parseIntEnv('TIME_DECAY_TP_HALVE_END_MINUTE', 30),
    timeDecayAfternoonTrailPct: parseFloatEnv('TIME_DECAY_AFTERNOON_TRAIL_PCT', 0.005),
    timeDecayAfternoonMinPnlPct: parseFloatEnv('TIME_DECAY_AFTERNOON_MIN_PNL_PCT', 0.015),
    volumeConfirmationVmaPeriod: parseIntEnv('VOLUME_CONFIRMATION_VMA_PERIOD', 10),
  },

  screener: {
    // Evening Core is off. Universe = pre-market gap + PM volume, liquid names.
    eveningScreenerEnabled: process.env.EVENING_SCREENER_ENABLED === 'true',
    adrGateEnabled: process.env.ADR_GATE_ENABLED === 'true',
    weinsteinGateEnabled: process.env.WEINSTEIN_GATE_ENABLED === 'true',
    minRelativeVolume: parseFloatEnv('MIN_RELATIVE_VOLUME', 2.0),
    minGapUpPct: parseFloatEnv('MIN_GAP_UP_PCT', 0.02),
    gapHoldTolerance: parseFloatEnv('GAP_HOLD_TOLERANCE', 0.01),
    watchlistMaxSize: parseIntEnv('WATCHLIST_MAX_SIZE', 50),
    relativeStrengthLookbackDays: parseIntEnv('RELATIVE_STRENGTH_LOOKBACK_DAYS', 20),
    volumeAverageDays: parseIntEnv('VOLUME_AVERAGE_DAYS', 14),
    minClosePrice: parseFloatEnv('MIN_CLOSE_PRICE', 5),
    maxClosePrice: parseFloatEnv('MAX_CLOSE_PRICE', 100),
    minDollarVolume: parseFloatEnv('MIN_DOLLAR_VOLUME', 20_000_000),
    minAdrPct: parseFloatEnv('MIN_ADR_PCT', 4.0),
    adrLookbackDays: parseIntEnv('ADR_LOOKBACK_DAYS', 14),
    // Float gate requires an external provider (Alpaca assets are unreliable for float).
    // Leave FLOAT_FILTER_ENABLED=false until Polygon/FMP/IEX Cloud is wired.
    floatFilterEnabled: process.env.FLOAT_FILTER_ENABLED === 'true',
    minFloatShares: parseIntEnv('MIN_FLOAT_SHARES', 10_000_000),
    maxFloatShares: parseIntEnv('MAX_FLOAT_SHARES', 500_000_000),
    allowedExchanges: ['NYSE', 'NASDAQ'] as readonly string[],
    // Weinstein Phase 2 (spec §2) — SMA 150/200 + slope over N weeks (~5 sessions/week)
    sma150Period: parseIntEnv('SMA_150_PERIOD', 150),
    sma200Period: parseIntEnv('SMA_200_PERIOD', 200),
    sma150SlopeWeeks: parseIntEnv('SMA_150_SLOPE_WEEKS', 8),
    // Reversal patterns (§3.A) — off by default on Hyper-Growth (no Weinstein path).
    patternFilterEnabled: process.env.PATTERN_FILTER_ENABLED === 'true',
    // Bumped to 120 to cover cup/flat lookbacks (was 90 for reversal-only).
    patternLookbackBars: parseIntEnv('PATTERN_LOOKBACK_BARS', 120),
    patternPivotLeft: parseIntEnv('PATTERN_PIVOT_LEFT', 3),
    patternPivotRight: parseIntEnv('PATTERN_PIVOT_RIGHT', 3),
    eteiBreakoutRvol: parseFloatEnv('ETEI_BREAKOUT_RVOL', 1.5),
    springReclaimRvol: parseFloatEnv('SPRING_RECLAIM_RVOL', 1.5),
    springSupportTolerancePct: parseFloatEnv('SPRING_SUPPORT_TOLERANCE_PCT', 0.005),
    patternRvolAvgDays: parseIntEnv('PATTERN_RVOL_AVG_DAYS', 14),
    // Continuation patterns (§3.B)
    bullFlagImpulseMinPct: parseFloatEnv('BULL_FLAG_IMPULSE_MIN_PCT', 0.08),
    bullFlagImpulseMaxBars: parseIntEnv('BULL_FLAG_IMPULSE_MAX_BARS', 10),
    bullFlagMinBars: parseIntEnv('BULL_FLAG_MIN_BARS', 3),
    bullFlagMaxBars: parseIntEnv('BULL_FLAG_MAX_BARS', 15),
    bullFlagVolDryUpRatio: parseFloatEnv('BULL_FLAG_VOL_DRY_UP_RATIO', 0.60),
    bullFlagBreakoutRvol: parseFloatEnv('BULL_FLAG_BREAKOUT_RVOL', 1.5),
    cupMinBars: parseIntEnv('CUP_MIN_BARS', 20),
    cupMaxBars: parseIntEnv('CUP_MAX_BARS', 65),
    cupMaxDepthPct: parseFloatEnv('CUP_MAX_DEPTH_PCT', 0.35),
    handleMaxRetracePct: parseFloatEnv('HANDLE_MAX_RETRACE_PCT', 0.15),
    handleMaxBars: parseIntEnv('HANDLE_MAX_BARS', 15),
    flatBaseBars: parseIntEnv('FLAT_BASE_BARS', 30),
    flatBaseAtrShort: parseIntEnv('FLAT_BASE_ATR_SHORT', 20),
    flatBaseAtrRef: parseIntEnv('FLAT_BASE_ATR_REF', 50),
    flatBaseAtrCompressionRatio: parseFloatEnv('FLAT_BASE_ATR_COMPRESSION_RATIO', 0.70),
  },

  // Straight-line run tag (#29) — soft annotate post-Weinstein, arms the
  // Opening Drive path only. Never rejects a Core candidate.
  straightRun: {
    minDays: parseIntEnv('STRAIGHT_RUN_MIN_DAYS', 5),
    maxDrawdownPct: parseFloatEnv('STRAIGHT_RUN_MAX_DD_PCT', 0.04),
    // Relative to the benchmark's own volume trend, not an absolute ratio.
    minMarketRelativeRvol: parseFloatEnv('STRAIGHT_RUN_MIN_REL_RVOL', 1.0),
    rvolBaselineDays: parseIntEnv('STRAIGHT_RUN_RVOL_BASELINE_DAYS', 14),
  },

  // Opening Drive — sole live entry path. ORB 1-min high break, 09:30–09:45 EST.
  // Volume + close location first. Spread and signed tape veto when present.
  openingDrive: {
    shadow: process.env.OD_SHADOW === 'true',
    windowStartHour: parseIntEnv('OD_WINDOW_START_HOUR', 9),
    windowStartMinute: parseIntEnv('OD_WINDOW_START_MINUTE', 30),
    windowEndHour: parseIntEnv('OD_WINDOW_END_HOUR', 9),
    windowEndMinute: parseIntEnv('OD_WINDOW_END_MINUTE', 45),
    minRvol1m: parseFloatEnv('OD_RVOL_1M', 2.0),
    maxExtensionPct: parseFloatEnv('OD_MAX_EXTENSION_PCT', 0.08),
    rvolBaselineBars: parseIntEnv('OD_RVOL_BASELINE_BARS', 20),
    minOrbVolumeMultiple: parseFloatEnv('OD_MIN_ORB_VOLUME_MULTIPLE', 1.5),
    minCloseLocation: parseFloatEnv('OD_MIN_CLOSE_LOCATION', 2 / 3),
    maxSpreadPct: parseFloatEnv('OD_MAX_SPREAD_PCT', 0.004),
    minTapeDelta: parseFloatEnv('OD_MIN_TAPE_DELTA', 0),
    tapeEnabled: process.env.OD_TAPE_ENABLED !== 'false',
    shadowHorizonMinutes: parseIntEnv('OD_SHADOW_HORIZON_MIN', 60),
  },

  premarket: {
    minGapUpPct: parseFloatEnv('PREMARKET_MIN_GAP_UP_PCT', 0),
    // Share volume summed on 1Min bars in EST [04:00, 09:30)
    minPreMarketShareVolume: parseIntEnv('PREMARKET_MIN_SHARE_VOLUME', 300_000),
    watchlistMaxSize: parseIntEnv('PREMARKET_WATCHLIST_MAX_SIZE', 30),
  },

  entry: {
    volumeBreakoutMultiplier: parseFloatEnv('VOLUME_BREAKOUT_MULTIPLIER', 1.5),
    minBarsForVolumeAvg: 5,
    signalBatchWindowMs: parseIntEnv('SIGNAL_BATCH_WINDOW_MS', 10000),
    tradeDuringLunch: process.env.TRADE_DURING_LUNCH === 'true',
    vwapPullbackEnabled: process.env.VWAP_PULLBACK_ENABLED === 'true',
    orbFiveMinEnabled: process.env.ORB_FIVE_MIN_ENABLED === 'true',
    orbWindowBars: parseIntEnv('ORB_WINDOW_BARS', 1),
    // V7 Core VWAP pullback: green 5m confirmation RVOL (was 1.2 legacy).
    minRvolForPullback: parseFloatEnv('MIN_RVOL_FOR_PULLBACK', 1.5),
    // Legacy V3 proximity (0.2%) — Satellite tick-up path only; Core uses vwapProximityPct.
    pullbackSupportPct: parseFloatEnv('PULLBACK_SUPPORT_PCT', 0.002),
    // V7 Core: |price - vwap| / vwap <= 0.3%.
    vwapProximityPct: parseFloatEnv('VWAP_PROXIMITY_PCT', 0.003),
    // Tracker high must reach this far above VWAP before a near-VWAP confirm (#32).
    vwapMinExtensionPct: parseFloatEnv('VWAP_MIN_EXTENSION_PCT', 0.005),
    // VWAP path only: gap-down AND alpha below this floor is a lagger (DOCN 20/08).
    vwapLaggerAlphaFloor: parseFloatEnv('VWAP_LAGGER_ALPHA_FLOOR', -0.10),
    // V7 Core entry window EST [start, end).
    entryWindowStartHour: parseIntEnv('ENTRY_WINDOW_START_HOUR', 10),
    entryWindowStartMinute: parseIntEnv('ENTRY_WINDOW_START_MINUTE', 0),
    entryWindowEndHour: parseIntEnv('ENTRY_WINDOW_END_HOUR', 11),
    entryWindowEndMinute: parseIntEnv('ENTRY_WINDOW_END_MINUTE', 30),
    // Pullback avg volume must be < ratio × impulse avg volume.
    pullbackDryUpRatio: parseFloatEnv('PULLBACK_DRY_UP_RATIO', 0.70),
    // N bars ending at VWAP breakout used as impulse baseline for dry-up.
    pullbackImpulseBars: parseIntEnv('PULLBACK_IMPULSE_BARS', 5),
    // Marketable limit: ask × multiplier (default +0.1% slippage cap).
    marketableLimitVwapMultiplier: parseFloatEnv('MARKETABLE_LIMIT_VWAP_MULTIPLIER', 1.001),
    // Anti-chase guard: max % the live ask may sit above the signal bar close
    // before the entry is abandoned. Prevents buying the top of a vertical spike
    // when the price ran away during the signal-batch debounce window.
    maxEntryChasePct: parseFloatEnv('MAX_ENTRY_CHASE_PCT', 3.0),
    // Entry-timing filter: skip entries when the 1-min RSI is already overbought
    // (chasing exhaustion). Distinct from the smart-exit RSI threshold.
    maxEntryRsi: parseFloatEnv('MAX_ENTRY_RSI', 75),
    entryRsiPeriod: parseIntEnv('ENTRY_RSI_PERIOD', 14),
  },

  fibonacci: {
    // Percentage distance from price to a Fibonacci level below which we consider
    // the price "near" that level (e.g. 1.5 means within 1.5% of the level price).
    proximityTolerancePct: parseFloatEnv('FIB_PROXIMITY_TOLERANCE_PCT', 1.5),
    // When true, entries are blocked if price is not within proximityTolerancePct
    // of any Fibonacci retracement level derived from the current session range.
    // Set FIB_BLOCK_IF_NOT_NEAR=false to revert to observatory-only mode.
    blockEntryIfNotNear: process.env.FIB_BLOCK_IF_NOT_NEAR !== 'false',
  },

  indicators: {
    atrPeriod: parseIntEnv('ATR_PERIOD', 14),
    ema9Period: parseIntEnv('EMA9_PERIOD', 9),
  },

  session: {
    marketOpenHour: 9,
    marketOpenMinute: 30,
    blackoutEndMinute: 45,
    lunchStartHour: 12,
    lunchEndHour: 14,
    eodSweepHour: 15,
    eodSweepMinute: 45,
    hardCloseHour: 15,
    hardCloseMinute: 55,
    eodReportHour: 16,
    eodReportMinute: 5,
    postMortemHour: 16,
    postMortemMinute: 0,
    screenerHour: 20,
    screenerMinute: 0,
    preMarketHour: 9,
    preMarketMinute: 15,
    // Legacy V3 cascade hours — unused since #30 (unified 3-slot pool).
    // Kept so an existing .env still loads.
    decayTier1Hour: parseIntEnv('DECAY_TIER1_HOUR', 10),
    decayTier1Minute: parseIntEnv('DECAY_TIER1_MINUTE', 15),
    decayTier2Hour: parseIntEnv('DECAY_TIER2_HOUR', 11),
    decayTier2Minute: parseIntEnv('DECAY_TIER2_MINUTE', 0),
    decayTier3Hour: parseIntEnv('DECAY_TIER3_HOUR', 11),
    decayTier3Minute: parseIntEnv('DECAY_TIER3_MINUTE', 45),
  },

  // Market-data bus — decouples WS ingest from strategy decision (V8)
  bus: {
    maxQueueSize: parseIntEnv('BUS_MAX_QUEUE', 10_000),
    dropPolicy: parseBusDropPolicy(process.env.BUS_DROP_POLICY),
  },

  // Offline replay (#11) — deterministic fixture playback into the market-data bus
  replay: {
    slippageBps: parseFloatEnv('REPLAY_SLIPPAGE_BPS', 0),
    fillDelayMs: parseIntEnv('REPLAY_FILL_DELAY_MS', 0),
    // Documented seed for future RNG extensions; current model is RNG-free.
    seed: process.env.REPLAY_SEED ?? '0',
  },

  // Level 2 / quotes microstructure (#8) — IEX top-of-book proxy when enabled
  level2: {
    enabled: process.env.LEVEL2_ENABLED === 'true',
    fastTrigger: process.env.L2_FAST_TRIGGER === 'true',
    topN: parseIntEnv('L2_TOP_N', 5),
    imbalanceThreshold: parseFloatEnv('L2_IMBALANCE_THRESHOLD', 0.65),
  },

  // Morning regime model (#9) — heuristic classifier + VIX volatility scaling
  regime: {
    enabled: process.env.REGIME_MODEL_ENABLED === 'true',
    // Log prediction without changing risk / R:R (paper shadow mode)
    shadow: process.env.REGIME_MODEL_SHADOW === 'true',
    vixRiskHalveThreshold: parseFloatEnv('VIX_RISK_HALVE_THRESHOLD', 25),
    choppyRr: parseFloatEnv('CHOPPY_RR', 1.5),
    // Heuristic CHOPPY: SPY ADR% >= floor AND VIX >= min (missing features → UNKNOWN)
    choppySpyAdrPct: parseFloatEnv('CHOPPY_SPY_ADR_PCT', 1.2),
    choppyVixMin: parseFloatEnv('CHOPPY_VIX_MIN', 18),
    // TODO(#26): migrate off unofficial Yahoo chart URL (CORS / route churn risk)
    // toward an official Alpaca market-data VIX (or VIX proxy ETF) source.
    vixYahooUrl:
      process.env.VIX_YAHOO_URL ??
      'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=5d',
  },

  // News catalyst / sentiment gate (#21) — Alpaca News + lexicon classifier
  sentiment: {
    enabled: process.env.SENTIMENT_FILTER_ENABLED === 'true',
    lookbackHours: parseIntEnv('SENTIMENT_LOOKBACK_HOURS', 48),
    maxHeadlinesPerSymbol: parseIntEnv('SENTIMENT_MAX_HEADLINES', 25),
    fetchConcurrency: parseIntEnv('SENTIMENT_FETCH_CONCURRENCY', 5),
  },

  paths: {
    watchlist: './data/watchlist.json',
    watchlistV2: './data/watchlist_v2.json',
    sessionState: './data/session_state.json',
    journal: './data/journal.json',
    heartbeat: parseStringEnv('HEARTBEAT_PATH', './data/heartbeat.json'),
    // Root of the per-trading-day adjusted daily-bar cache (data/eod/<day>/<sym>.json).
    eodCache: parseStringEnv('EOD_CACHE_PATH', './data/eod'),
    // Opening Drive observations. Kept apart from journal.json so hypothetical
    // fills never reach the FeedbackEngine.
    shadowSignals: parseStringEnv('OD_SHADOW_PATH', './data/shadow_signals.json'),
  },

  // Liveness contract consumed by the standalone watchdog process.
  // The bot only produces the heartbeat; it never reads it back.
  health: {
    heartbeatIntervalMs: parseIntEnv('HEARTBEAT_INTERVAL_MS', 20_000),
  },

  notify: {
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL ?? null,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? null,
    telegramChatId: process.env.TELEGRAM_CHAT_ID ?? null,
  },
};

// Fail-fast validation of risk parameters at startup
(function validateConfig(): void {
  const r = config.risk;

  if (r.maxPositionPct <= 0 || r.maxPositionPct > 1.0)
    throw new Error(`[SYSTEM] MAX_POSITION_PCT out of bounds (0–1.0): ${r.maxPositionPct}`);

  if (r.strategyCapitalUsd < 0)
    throw new Error(`[SYSTEM] STRATEGY_CAPITAL_USD must be >= 0: ${r.strategyCapitalUsd}`);

  if (r.riskPerTradePct <= 0 || r.riskPerTradePct > 0.25)
    throw new Error(`[SYSTEM] RISK_PER_TRADE_PCT must be between 0 and 25%: ${r.riskPerTradePct}`);

  if (r.minRiskRewardRatio < 1 || r.minRiskRewardRatio > 10)
    throw new Error(`[SYSTEM] MIN_RISK_REWARD_RATIO out of bounds (1–10): ${r.minRiskRewardRatio}`);

  if (r.atrTrailTriggerPct <= 0 || r.atrTrailTriggerPct > 0.35)
    throw new Error(`[SYSTEM] ATR_TRAIL_TRIGGER_PCT out of bounds (0–35%): ${r.atrTrailTriggerPct}`);

  if (r.atrTrailMultiplier < 1 || r.atrTrailMultiplier > 5)
    throw new Error(`[SYSTEM] ATR_TRAIL_MULTIPLIER out of bounds (1–5): ${r.atrTrailMultiplier}`);

  if (r.trailingStopPct <= 0 || r.trailingStopPct >= 1)
    throw new Error(`[SYSTEM] TRAILING_STOP_PCT out of bounds (0–1): ${r.trailingStopPct}`);

  // A percent trail armed too early is a risk widener, not a protection: the
  // stop lands below entry and the initial hard stop has already been cancelled.
  if (r.usePercentTrail) {
    if (!isProfitLockingTrail(r.atrTrailTriggerPct, r.trailingStopPct)) {
      const lockedPct = computeTrailLockedPct(r.atrTrailTriggerPct, r.trailingStopPct);
      const minTrigger = minProfitLockingTriggerPct(r.trailingStopPct);
      throw new Error(
        `[SYSTEM] ATR_TRAIL_TRIGGER_PCT (${(r.atrTrailTriggerPct * 100).toFixed(1)}%) is too low ` +
        `for TRAILING_STOP_PCT (${(r.trailingStopPct * 100).toFixed(1)}%): arming the trail would ` +
        `set the stop at ${(lockedPct * 100).toFixed(2)}% of entry. ` +
        `Raise the trigger above ${(minTrigger * 100).toFixed(2)}% or tighten the trail.`,
      );
    }
  }

  if (r.timeStopMinutes < 5 || r.timeStopMinutes > 240)
    throw new Error(`[SYSTEM] TIME_STOP_MINUTES out of bounds (5–240): ${r.timeStopMinutes}`);

  if (r.maxPositions < 1 || r.maxPositions > 20)
    throw new Error(`[SYSTEM] MAX_POSITIONS must be between 1 and 20: ${r.maxPositions}`);

  if (r.hardStopFloorPct < 0.005 || r.hardStopFloorPct > 0.1)
    throw new Error(`[SYSTEM] HARD_STOP_FLOOR_PCT out of bounds (0.5%–10%): ${r.hardStopFloorPct}`);

  if (r.scaleOutEnabled && r.scaleOutTargetPct <= r.hardStopFloorPct)
    throw new Error('[SYSTEM] SCALE_OUT_TARGET_PCT must be > HARD_STOP_FLOOR_PCT');

  // 0 disables the daily profit circuit breaker; the drawdown kill-switch is independent.
  if (r.dailyProfitTargetPct < 0 || r.dailyProfitTargetPct > 0.1)
    throw new Error(`[SYSTEM] DAILY_PROFIT_TARGET_PCT out of bounds (0–10%): ${r.dailyProfitTargetPct}`);

  // Below 1s the writer would thrash the disk; above 60s the watchdog cannot
  // distinguish a slow heartbeat from a dead process within a useful delay.
  if (config.health.heartbeatIntervalMs < 1000 || config.health.heartbeatIntervalMs > 60_000) {
    throw new Error(
      `[SYSTEM] HEARTBEAT_INTERVAL_MS out of bounds (1000–60000): ${config.health.heartbeatIntervalMs}`,
    );
  }

  const e = config.entry;
  if (e.maxEntryChasePct < 0 || e.maxEntryChasePct > 10)
    throw new Error(`[SYSTEM] MAX_ENTRY_CHASE_PCT out of bounds (0–10%): ${e.maxEntryChasePct}`);

  if (e.maxEntryRsi < 50 || e.maxEntryRsi > 100)
    throw new Error(`[SYSTEM] MAX_ENTRY_RSI out of bounds (50–100): ${e.maxEntryRsi}`);

  if (e.vwapProximityPct <= 0 || e.vwapProximityPct > 0.05) {
    throw new Error(
      `[SYSTEM] VWAP_PROXIMITY_PCT out of bounds (0–5%]: ${e.vwapProximityPct}`,
    );
  }
  if (e.vwapMinExtensionPct <= 0 || e.vwapMinExtensionPct > 0.05) {
    throw new Error(
      `[SYSTEM] VWAP_MIN_EXTENSION_PCT out of bounds (0–5%]: ${e.vwapMinExtensionPct}`,
    );
  }
  if (e.vwapMinExtensionPct <= e.vwapProximityPct) {
    throw new Error(
      `[SYSTEM] VWAP_MIN_EXTENSION_PCT (${e.vwapMinExtensionPct}) must be > ` +
      `VWAP_PROXIMITY_PCT (${e.vwapProximityPct})`,
    );
  }
  if (e.vwapLaggerAlphaFloor < -1 || e.vwapLaggerAlphaFloor > 0) {
    throw new Error(
      `[SYSTEM] VWAP_LAGGER_ALPHA_FLOOR out of bounds [-1, 0]: ${e.vwapLaggerAlphaFloor}`,
    );
  }
  if (e.minRvolForPullback <= 0) {
    throw new Error(`[SYSTEM] MIN_RVOL_FOR_PULLBACK must be > 0: ${e.minRvolForPullback}`);
  }
  if (e.pullbackDryUpRatio <= 0 || e.pullbackDryUpRatio > 1) {
    throw new Error(
      `[SYSTEM] PULLBACK_DRY_UP_RATIO out of bounds (0–1]: ${e.pullbackDryUpRatio}`,
    );
  }
  if (e.pullbackImpulseBars < 1) {
    throw new Error(`[SYSTEM] PULLBACK_IMPULSE_BARS must be >= 1: ${e.pullbackImpulseBars}`);
  }
  const entryStartMins = e.entryWindowStartHour * 60 + e.entryWindowStartMinute;
  const entryEndMins = e.entryWindowEndHour * 60 + e.entryWindowEndMinute;
  if (
    e.entryWindowStartHour < 0 || e.entryWindowStartHour > 23 ||
    e.entryWindowEndHour < 0 || e.entryWindowEndHour > 23 ||
    e.entryWindowStartMinute < 0 || e.entryWindowStartMinute > 59 ||
    e.entryWindowEndMinute < 0 || e.entryWindowEndMinute > 59
  ) {
    throw new Error('[SYSTEM] ENTRY_WINDOW_* hour/minute out of bounds');
  }
  if (entryStartMins >= entryEndMins) {
    throw new Error(
      `[SYSTEM] ENTRY_WINDOW start must be < end: ${entryStartMins} >= ${entryEndMins}`,
    );
  }

  const s = config.screener;
  if (s.minClosePrice <= 0) {
    throw new Error(`[SYSTEM] MIN_CLOSE_PRICE must be > 0: ${s.minClosePrice}`);
  }
  if (s.maxClosePrice <= s.minClosePrice) {
    throw new Error(
      `[SYSTEM] MAX_CLOSE_PRICE must be > MIN_CLOSE_PRICE: ` +
      `${s.maxClosePrice} <= ${s.minClosePrice}`,
    );
  }
  if (s.minDollarVolume <= 0) {
    throw new Error(`[SYSTEM] MIN_DOLLAR_VOLUME must be > 0: ${s.minDollarVolume}`);
  }
  if (s.relativeStrengthLookbackDays < 1) {
    throw new Error(
      `[SYSTEM] RELATIVE_STRENGTH_LOOKBACK_DAYS must be >= 1: ${s.relativeStrengthLookbackDays}`,
    );
  }
  if (s.volumeAverageDays < 1) {
    throw new Error(
      `[SYSTEM] VOLUME_AVERAGE_DAYS must be >= 1: ${s.volumeAverageDays}`,
    );
  }
  if (s.minAdrPct <= 0) {
    throw new Error(`[SYSTEM] MIN_ADR_PCT must be > 0: ${s.minAdrPct}`);
  }
  if (s.adrLookbackDays < 1) {
    throw new Error(`[SYSTEM] ADR_LOOKBACK_DAYS must be >= 1: ${s.adrLookbackDays}`);
  }
  if (s.minFloatShares <= 0 || s.maxFloatShares <= 0) {
    throw new Error('[SYSTEM] MIN_FLOAT_SHARES and MAX_FLOAT_SHARES must be > 0');
  }
  if (s.minFloatShares >= s.maxFloatShares) {
    throw new Error(
      `[SYSTEM] MIN_FLOAT_SHARES must be < MAX_FLOAT_SHARES: ` +
      `${s.minFloatShares} >= ${s.maxFloatShares}`,
    );
  }
  if (s.allowedExchanges.length === 0) {
    throw new Error('[SYSTEM] screener.allowedExchanges must not be empty');
  }
  if (s.sma150Period < 1) {
    throw new Error(`[SYSTEM] SMA_150_PERIOD must be >= 1: ${s.sma150Period}`);
  }
  if (s.sma200Period < 1) {
    throw new Error(`[SYSTEM] SMA_200_PERIOD must be >= 1: ${s.sma200Period}`);
  }
  if (s.sma200Period < s.sma150Period) {
    throw new Error(
      `[SYSTEM] SMA_200_PERIOD must be >= SMA_150_PERIOD: ` +
      `${s.sma200Period} < ${s.sma150Period}`,
    );
  }
  if (s.sma150SlopeWeeks < 1) {
    throw new Error(`[SYSTEM] SMA_150_SLOPE_WEEKS must be >= 1: ${s.sma150SlopeWeeks}`);
  }
  if (s.patternPivotLeft < 1 || s.patternPivotRight < 1) {
    throw new Error('[SYSTEM] PATTERN_PIVOT_LEFT/RIGHT must be >= 1');
  }
  const minPatternLookback = Math.max(
    s.patternPivotLeft + s.patternPivotRight + 5,
    s.flatBaseBars + s.flatBaseAtrRef,
    s.cupMinBars + s.handleMaxBars,
  );
  if (s.patternLookbackBars < minPatternLookback) {
    throw new Error(
      `[SYSTEM] PATTERN_LOOKBACK_BARS must be >= ${minPatternLookback}: ${s.patternLookbackBars}`,
    );
  }
  if (s.eteiBreakoutRvol <= 0) {
    throw new Error(`[SYSTEM] ETEI_BREAKOUT_RVOL must be > 0: ${s.eteiBreakoutRvol}`);
  }

  const sr = config.straightRun;
  if (sr.minDays < 2) {
    throw new Error(`[SYSTEM] STRAIGHT_RUN_MIN_DAYS must be >= 2: ${sr.minDays}`);
  }
  if (sr.maxDrawdownPct <= 0 || sr.maxDrawdownPct >= 1) {
    throw new Error(
      `[SYSTEM] STRAIGHT_RUN_MAX_DD_PCT must be between 0 and 1: ${sr.maxDrawdownPct}`,
    );
  }
  if (sr.minMarketRelativeRvol <= 0) {
    throw new Error(
      `[SYSTEM] STRAIGHT_RUN_MIN_REL_RVOL must be > 0: ${sr.minMarketRelativeRvol}`,
    );
  }
  if (sr.rvolBaselineDays < 1) {
    throw new Error(
      `[SYSTEM] STRAIGHT_RUN_RVOL_BASELINE_DAYS must be >= 1: ${sr.rvolBaselineDays}`,
    );
  }

  const od = config.openingDrive;
  const odStart = od.windowStartHour * 60 + od.windowStartMinute;
  const odEnd = od.windowEndHour * 60 + od.windowEndMinute;
  if (odStart >= odEnd) {
    throw new Error(`[SYSTEM] OD window start must precede end: ${odStart} >= ${odEnd}`);
  }
  if (od.minRvol1m <= 0) {
    throw new Error(`[SYSTEM] OD_RVOL_1M must be > 0: ${od.minRvol1m}`);
  }
  if (od.minOrbVolumeMultiple <= 0) {
    throw new Error(
      `[SYSTEM] OD_MIN_ORB_VOLUME_MULTIPLE must be > 0: ${od.minOrbVolumeMultiple}`,
    );
  }
  if (od.minCloseLocation <= 0.5 || od.minCloseLocation > 1) {
    throw new Error(
      `[SYSTEM] OD_MIN_CLOSE_LOCATION must be in (0.5, 1]: ${od.minCloseLocation}`,
    );
  }
  if (od.maxSpreadPct <= 0 || od.maxSpreadPct > 0.05) {
    throw new Error(
      `[SYSTEM] OD_MAX_SPREAD_PCT must be in (0, 0.05]: ${od.maxSpreadPct}`,
    );
  }
  if (od.minTapeDelta < -1 || od.minTapeDelta >= 1) {
    throw new Error(
      `[SYSTEM] OD_MIN_TAPE_DELTA must be in [-1, 1): ${od.minTapeDelta}`,
    );
  }
  if (od.maxExtensionPct <= 0 || od.maxExtensionPct >= 1) {
    throw new Error(
      `[SYSTEM] OD_MAX_EXTENSION_PCT must be between 0 and 1: ${od.maxExtensionPct}`,
    );
  }
  if (od.rvolBaselineBars < 2) {
    throw new Error(`[SYSTEM] OD_RVOL_BASELINE_BARS must be >= 2: ${od.rvolBaselineBars}`);
  }
  if (od.shadowHorizonMinutes < 1) {
    throw new Error(
      `[SYSTEM] OD_SHADOW_HORIZON_MIN must be >= 1: ${od.shadowHorizonMinutes}`,
    );
  }
  if (s.springReclaimRvol <= 0) {
    throw new Error(`[SYSTEM] SPRING_RECLAIM_RVOL must be > 0: ${s.springReclaimRvol}`);
  }
  if (s.springSupportTolerancePct <= 0 || s.springSupportTolerancePct > 0.05) {
    throw new Error(
      `[SYSTEM] SPRING_SUPPORT_TOLERANCE_PCT out of bounds (0–5%]: ${s.springSupportTolerancePct}`,
    );
  }
  if (s.patternRvolAvgDays < 1) {
    throw new Error(`[SYSTEM] PATTERN_RVOL_AVG_DAYS must be >= 1: ${s.patternRvolAvgDays}`);
  }
  if (s.bullFlagImpulseMinPct <= 0 || s.bullFlagImpulseMinPct > 1) {
    throw new Error(
      `[SYSTEM] BULL_FLAG_IMPULSE_MIN_PCT out of bounds (0–1]: ${s.bullFlagImpulseMinPct}`,
    );
  }
  if (s.bullFlagImpulseMaxBars < 2) {
    throw new Error(`[SYSTEM] BULL_FLAG_IMPULSE_MAX_BARS must be >= 2`);
  }
  if (s.bullFlagMinBars < 1 || s.bullFlagMaxBars < s.bullFlagMinBars) {
    throw new Error('[SYSTEM] BULL_FLAG_MIN/MAX_BARS invalid');
  }
  if (s.bullFlagVolDryUpRatio <= 0 || s.bullFlagVolDryUpRatio > 1) {
    throw new Error(
      `[SYSTEM] BULL_FLAG_VOL_DRY_UP_RATIO out of bounds (0–1]: ${s.bullFlagVolDryUpRatio}`,
    );
  }
  if (s.bullFlagBreakoutRvol <= 0) {
    throw new Error(`[SYSTEM] BULL_FLAG_BREAKOUT_RVOL must be > 0`);
  }
  if (s.cupMinBars < 5 || s.cupMaxBars < s.cupMinBars) {
    throw new Error('[SYSTEM] CUP_MIN/MAX_BARS invalid');
  }
  if (s.cupMaxDepthPct <= 0 || s.cupMaxDepthPct > 1) {
    throw new Error(`[SYSTEM] CUP_MAX_DEPTH_PCT out of bounds (0–1]: ${s.cupMaxDepthPct}`);
  }
  if (s.handleMaxRetracePct <= 0 || s.handleMaxRetracePct > 0.15) {
    throw new Error(
      `[SYSTEM] HANDLE_MAX_RETRACE_PCT out of bounds (0–15%]: ${s.handleMaxRetracePct}`,
    );
  }
  if (s.handleMaxBars < 1) {
    throw new Error('[SYSTEM] HANDLE_MAX_BARS must be >= 1');
  }
  if (s.flatBaseBars < 5) {
    throw new Error('[SYSTEM] FLAT_BASE_BARS must be >= 5');
  }
  if (s.flatBaseAtrShort < 2 || s.flatBaseAtrRef < s.flatBaseAtrShort) {
    throw new Error('[SYSTEM] FLAT_BASE_ATR_SHORT/REF invalid');
  }
  if (s.flatBaseAtrCompressionRatio <= 0 || s.flatBaseAtrCompressionRatio > 1) {
    throw new Error(
      `[SYSTEM] FLAT_BASE_ATR_COMPRESSION_RATIO out of bounds (0–1]: ${s.flatBaseAtrCompressionRatio}`,
    );
  }

  const pm = config.premarket;
  if (pm.minPreMarketShareVolume <= 0) {
    throw new Error(
      `[SYSTEM] PREMARKET_MIN_SHARE_VOLUME must be > 0: ${pm.minPreMarketShareVolume}`,
    );
  }
  if (pm.minGapUpPct < 0) {
    throw new Error(`[SYSTEM] PREMARKET_MIN_GAP_UP_PCT must be >= 0: ${pm.minGapUpPct}`);
  }
  if (pm.watchlistMaxSize < 1) {
    throw new Error(
      `[SYSTEM] PREMARKET_WATCHLIST_MAX_SIZE must be >= 1: ${pm.watchlistMaxSize}`,
    );
  }

  const sess = config.session;
  const decayMins = [
    sess.decayTier1Hour * 60 + sess.decayTier1Minute,
    sess.decayTier2Hour * 60 + sess.decayTier2Minute,
    sess.decayTier3Hour * 60 + sess.decayTier3Minute,
  ];
  for (const [label, hour, minute] of [
    ['DECAY_TIER1', sess.decayTier1Hour, sess.decayTier1Minute],
    ['DECAY_TIER2', sess.decayTier2Hour, sess.decayTier2Minute],
    ['DECAY_TIER3', sess.decayTier3Hour, sess.decayTier3Minute],
  ] as const) {
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new Error(`[SYSTEM] ${label}_HOUR/MINUTE out of bounds`);
    }
  }
  if (!(decayMins[0] < decayMins[1] && decayMins[1] < decayMins[2])) {
    throw new Error(
      `[SYSTEM] DECAY_TIER times must be strictly increasing: ${decayMins.join(' < ')}`,
    );
  }

  const bus = config.bus;
  if (bus.maxQueueSize < 1) {
    throw new Error(`[SYSTEM] BUS_MAX_QUEUE must be >= 1: ${bus.maxQueueSize}`);
  }

  const replay = config.replay;
  if (replay.slippageBps < 0) {
    throw new Error(`[SYSTEM] REPLAY_SLIPPAGE_BPS must be >= 0: ${replay.slippageBps}`);
  }
  if (replay.fillDelayMs < 0) {
    throw new Error(`[SYSTEM] REPLAY_FILL_DELAY_MS must be >= 0: ${replay.fillDelayMs}`);
  }

  const l2 = config.level2;
  if (l2.topN < 1) {
    throw new Error(`[SYSTEM] L2_TOP_N must be >= 1: ${l2.topN}`);
  }
  if (l2.imbalanceThreshold <= 0 || l2.imbalanceThreshold > 1) {
    throw new Error(
      `[SYSTEM] L2_IMBALANCE_THRESHOLD out of bounds (0–1]: ${l2.imbalanceThreshold}`,
    );
  }

  const rg = config.regime;
  if (rg.vixRiskHalveThreshold < 10 || rg.vixRiskHalveThreshold > 80) {
    throw new Error(
      `[SYSTEM] VIX_RISK_HALVE_THRESHOLD out of bounds (10–80]: ${rg.vixRiskHalveThreshold}`,
    );
  }
  if (rg.choppyRr < 1 || rg.choppyRr > config.risk.minRiskRewardRatio) {
    throw new Error(
      `[SYSTEM] CHOPPY_RR must be in [1, MIN_RISK_REWARD_RATIO]: ${rg.choppyRr}`,
    );
  }
  if (rg.choppySpyAdrPct <= 0) {
    throw new Error(`[SYSTEM] CHOPPY_SPY_ADR_PCT must be > 0: ${rg.choppySpyAdrPct}`);
  }
  if (rg.choppyVixMin < 0 || rg.choppyVixMin > rg.vixRiskHalveThreshold) {
    throw new Error(
      `[SYSTEM] CHOPPY_VIX_MIN must be in [0, VIX_RISK_HALVE_THRESHOLD]: ${rg.choppyVixMin}`,
    );
  }

  const sent = config.sentiment;
  if (sent.lookbackHours < 1 || sent.lookbackHours > 168) {
    throw new Error(
      `[SYSTEM] SENTIMENT_LOOKBACK_HOURS out of bounds (1–168): ${sent.lookbackHours}`,
    );
  }
  if (sent.maxHeadlinesPerSymbol < 1 || sent.maxHeadlinesPerSymbol > 50) {
    throw new Error(
      `[SYSTEM] SENTIMENT_MAX_HEADLINES out of bounds (1–50): ${sent.maxHeadlinesPerSymbol}`,
    );
  }
  if (sent.fetchConcurrency < 1 || sent.fetchConcurrency > 20) {
    throw new Error(
      `[SYSTEM] SENTIMENT_FETCH_CONCURRENCY out of bounds (1–20): ${sent.fetchConcurrency}`,
    );
  }
}());

/** Trading sessions approximating N calendar weeks (5 sessions/week). */
export function getSma150SlopeLookbackBars(): number {
  return config.screener.sma150SlopeWeeks * 5;
}

/**
 * @deprecated V7 sizes by riskPerTradePct (equity % / stop distance), not CTPO slots.
 * Retained for observability / legacy callers that still reason in equal slot shares.
 * Position count remains capped by maxPositions.
 */
export function getSlotCapitalShare(): number {
  return 1 / config.risk.maxPositions;
}

export default config;
