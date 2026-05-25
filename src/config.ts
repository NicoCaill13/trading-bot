import dotenv from 'dotenv';
dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`[SYSTEM] Missing environment variable: ${key}`);
  }
  return value;
}

function parseFloatEnv(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = parseFloat(raw);
  if (isNaN(parsed)) throw new Error(`[SYSTEM] Invalid float for ${key}: "${raw}"`);
  return parsed;
}

function parseIntEnv(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) throw new Error(`[SYSTEM] Invalid integer for ${key}: "${raw}"`);
  return parsed;
}

const config = {
  alpaca: {
    keyId: requireEnv('ALPACA_KEY_ID'),
    secretKey: requireEnv('ALPACA_SECRET_KEY'),
    baseUrl: process.env.ALPACA_BASE_URL ?? 'https://paper-api.alpaca.markets',
    dataUrl: process.env.ALPACA_DATA_URL ?? 'https://data.alpaca.markets',
    paper: true as const,
  },

  risk: {
    maxPositions: parseIntEnv('MAX_POSITIONS', 5),
    maxPositionPct: parseFloatEnv('MAX_POSITION_PCT', 0.20),
    riskPerTradePct: parseFloatEnv('RISK_PER_TRADE_PCT', 0.01),
    atrStopMultiplier: parseFloatEnv('ATR_STOP_MULTIPLIER', 1.5),
    hardStopFloorPct: parseFloatEnv('HARD_STOP_FLOOR_PCT', 0.015),
    scaleOutTargetPctCore: parseFloatEnv('SCALE_OUT_TARGET_PCT_CORE', 0.05),
    scaleOutTargetPctSatellite: parseFloatEnv('SCALE_OUT_TARGET_PCT_SATELLITE', 0.07),
    trailingStopPct: parseFloatEnv('TRAILING_STOP_PCT', 0.015),
    scaleOutSettlementDelayMs: parseIntEnv('SCALE_OUT_SETTLEMENT_DELAY_MS', 3000),
    eodTightTrailPct: parseFloatEnv('EOD_TIGHT_TRAIL_PCT', 0.005),
    dailyProfitTargetPct: parseFloatEnv('DAILY_PROFIT_TARGET_PCT', 0.01),
    dailyDrawdownLimitDollars: parseFloatEnv('DAILY_DRAWDOWN_LIMIT_DOLLARS', -1500),
    dailyDrawdownLimitPct: parseFloatEnv('DAILY_DRAWDOWN_LIMIT_PCT', -0.015),
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
    minRelativeVolume: parseFloatEnv('MIN_RELATIVE_VOLUME', 2.0),
    minGapUpPct: parseFloatEnv('MIN_GAP_UP_PCT', 0.02),
    gapHoldTolerance: parseFloatEnv('GAP_HOLD_TOLERANCE', 0.01),
    watchlistMaxSize: parseIntEnv('WATCHLIST_MAX_SIZE', 50),
    relativeStrengthLookbackDays: 20,
    volumeAverageDays: 14,
    minClosePrice: parseFloatEnv('MIN_CLOSE_PRICE', 10),
    minDollarVolume: parseFloatEnv('MIN_DOLLAR_VOLUME', 50_000_000),
  },

  portfolio: {
    coreRiskShare: parseFloatEnv('CORE_RISK_SHARE', 0.80),
    satelliteRiskShare: parseFloatEnv('SATELLITE_RISK_SHARE', 0.20),
    coreMaxPositions: parseIntEnv('CORE_MAX_POSITIONS', 0),
    satelliteMaxPositions: parseIntEnv('SATELLITE_MAX_POSITIONS', 0),
  },

  premarket: {
    minGapUpPct: parseFloatEnv('PREMARKET_MIN_GAP_UP_PCT', 0.04),
    minPreMarketShareVolume: parseIntEnv('PREMARKET_MIN_SHARE_VOLUME', 100_000),
    watchlistMaxSize: parseIntEnv('PREMARKET_WATCHLIST_MAX_SIZE', 10),
  },

  entry: {
    volumeBreakoutMultiplier: parseFloatEnv('VOLUME_BREAKOUT_MULTIPLIER', 1.5),
    minBarsForVolumeAvg: 5,
    signalBatchWindowMs: parseIntEnv('SIGNAL_BATCH_WINDOW_MS', 10000),
    tradeDuringLunch: process.env.TRADE_DURING_LUNCH === 'true',
    orbWindowBars: parseIntEnv('ORB_WINDOW_BARS', 1),
    minRvolForPullback: parseFloatEnv('MIN_RVOL_FOR_PULLBACK', 1.2),
    pullbackSupportPct: parseFloatEnv('PULLBACK_SUPPORT_PCT', 0.002),
    // Marketable limit: ask × multiplier (default +0.1% slippage cap).
    marketableLimitVwapMultiplier: parseFloatEnv('MARKETABLE_LIMIT_VWAP_MULTIPLIER', 1.001),
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
    hardCloseMinute: 58,
    eodReportHour: 16,
    eodReportMinute: 5,
    postMortemHour: 16,
    postMortemMinute: 0,
    screenerHour: 20,
    screenerMinute: 0,
    preMarketHour: 9,
    preMarketMinute: 15,
  },

  paths: {
    watchlist: './data/watchlist.json',
    watchlistV2: './data/watchlist_v2.json',
    sessionState: './data/session_state.json',
    journal: './data/journal.json',
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

  if (r.riskPerTradePct <= 0 || r.riskPerTradePct > 0.05)
    throw new Error(`[SYSTEM] RISK_PER_TRADE_PCT must be between 0 and 5%: ${r.riskPerTradePct}`);

  if (r.maxPositions < 1 || r.maxPositions > 20)
    throw new Error(`[SYSTEM] MAX_POSITIONS must be between 1 and 20: ${r.maxPositions}`);

  if (r.hardStopFloorPct < 0.005 || r.hardStopFloorPct > 0.1)
    throw new Error(`[SYSTEM] HARD_STOP_FLOOR_PCT out of bounds (0.5%–10%): ${r.hardStopFloorPct}`);

  if (r.scaleOutTargetPctCore <= r.hardStopFloorPct)
    throw new Error('[SYSTEM] SCALE_OUT_TARGET_PCT_CORE must be > HARD_STOP_FLOOR_PCT');

  if (r.scaleOutTargetPctSatellite <= r.scaleOutTargetPctCore)
    throw new Error('[SYSTEM] SCALE_OUT_TARGET_PCT_SATELLITE must be > SCALE_OUT_TARGET_PCT_CORE');

  if (r.dailyProfitTargetPct <= 0 || r.dailyProfitTargetPct > 0.1)
    throw new Error(`[SYSTEM] DAILY_PROFIT_TARGET_PCT out of bounds (0–10%): ${r.dailyProfitTargetPct}`);

  const p = config.portfolio;
  const shareSum = p.coreRiskShare + p.satelliteRiskShare;
  if (Math.abs(shareSum - 1.0) > 0.001) {
    throw new Error(
      `[SYSTEM] CORE_RISK_SHARE + SATELLITE_RISK_SHARE must equal 1.0: ${shareSum}`,
    );
  }

  if (p.coreRiskShare <= 0 || p.satelliteRiskShare <= 0) {
    throw new Error('[SYSTEM] CORE_RISK_SHARE and SATELLITE_RISK_SHARE must be > 0');
  }

  const slots = getPortfolioSlotLimits();
  if (slots.coreMaxPositions + slots.satelliteMaxPositions > r.maxPositions) {
    throw new Error(
      `[SYSTEM] Core + Satellite slots (${slots.coreMaxPositions + slots.satelliteMaxPositions}) ` +
      `exceed MAX_POSITIONS (${r.maxPositions})`,
    );
  }
}());

export function getPortfolioSlotLimits(): {
  coreMaxPositions: number;
  satelliteMaxPositions: number;
} {
  const max = config.risk.maxPositions;
  let core = config.portfolio.coreMaxPositions;
  let satellite = config.portfolio.satelliteMaxPositions;

  if (core <= 0) {
    core = Math.floor(max * config.portfolio.coreRiskShare);
  }
  if (satellite <= 0) {
    satellite = max - core;
  }

  return { coreMaxPositions: core, satelliteMaxPositions: satellite };
}

/**
 * V3 time-decay slot allocation. Cascades forward only when activeCore is below
 * the threshold for each tier; otherwise the previous tier limits remain.
 */
export function getTimedecaySlotLimits(
  estNow: Date,
  activeCoreCount: number,
): { coreMaxPositions: number; satelliteMaxPositions: number } {
  const max = config.risk.maxPositions;
  const minutesSinceMidnight = estNow.getHours() * 60 + estNow.getMinutes();
  const t1015 = 10 * 60 + 15;
  const t1100 = 11 * 60;
  const t1145 = 11 * 60 + 45;

  let core = 4;
  let satellite = max - core;

  if (minutesSinceMidnight >= t1015 && activeCoreCount < 4) {
    core = 3;
    satellite = 2;
  }
  if (minutesSinceMidnight >= t1100 && activeCoreCount < 3) {
    core = 2;
    satellite = 3;
  }
  if (minutesSinceMidnight >= t1145 && activeCoreCount < 2) {
    core = 1;
    satellite = 4;
  }

  if (core + satellite !== max) {
    satellite = max - core;
  }

  return { coreMaxPositions: core, satelliteMaxPositions: satellite };
}

/**
 * CTPO slot equiparity: each position consumes exactly 1/maxPositions of total equity.
 * Core and Satellite use the same envelope — tier is for routing/observability only.
 */
export function getSlotCapitalShare(): number {
  return 1 / config.risk.maxPositions;
}

export function getRiskShareForTier(tier: 'core' | 'satellite'): number {
  return tier === 'core'
    ? config.portfolio.coreRiskShare
    : config.portfolio.satelliteRiskShare;
}

export function getMaxPositionPctForTier(tier: 'core' | 'satellite'): number {
  const share = getRiskShareForTier(tier);
  return config.risk.maxPositionPct * share;
}

export default config;
