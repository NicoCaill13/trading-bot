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
    keyId:     requireEnv('ALPACA_KEY_ID'),
    secretKey: requireEnv('ALPACA_SECRET_KEY'),
    baseUrl:   process.env.ALPACA_BASE_URL ?? 'https://paper-api.alpaca.markets',
    dataUrl:   process.env.ALPACA_DATA_URL ?? 'https://data.alpaca.markets',
    paper:     true as const,
  },

  risk: {
    maxPositions:         parseIntEnv('MAX_POSITIONS', 5),
    maxPositionPct:       parseFloatEnv('MAX_POSITION_PCT', 0.20),
    riskPerTradePct:      parseFloatEnv('RISK_PER_TRADE_PCT', 0.01),
    atrStopMultiplier:    parseFloatEnv('ATR_STOP_MULTIPLIER', 1.5),
    hardStopFloorPct:     parseFloatEnv('HARD_STOP_FLOOR_PCT', 0.015),
    scaleOutTargetPct:    parseFloatEnv('SCALE_OUT_TARGET_PCT', 0.03),
    trailingStopPct:      parseFloatEnv('TRAILING_STOP_PCT', 0.015),
    eodTightTrailPct:     parseFloatEnv('EOD_TIGHT_TRAIL_PCT', 0.005),
    dailyProfitTargetPct: parseFloatEnv('DAILY_PROFIT_TARGET_PCT', 0.01),
  },

  screener: {
    minRelativeVolume:            parseFloatEnv('MIN_RELATIVE_VOLUME', 2.0),
    minGapUpPct:                  parseFloatEnv('MIN_GAP_UP_PCT', 0.02),
    gapHoldTolerance:             parseFloatEnv('GAP_HOLD_TOLERANCE', 0.01),
    watchlistMaxSize:             parseIntEnv('WATCHLIST_MAX_SIZE', 50),
    relativeStrengthLookbackDays: 20,
    volumeAverageDays:            14,
    minClosePrice:                parseFloatEnv('MIN_CLOSE_PRICE', 10),
    minDollarVolume:              parseFloatEnv('MIN_DOLLAR_VOLUME', 50_000_000),
  },

  entry: {
    volumeBreakoutMultiplier: parseFloatEnv('VOLUME_BREAKOUT_MULTIPLIER', 1.5),
    minBarsForVolumeAvg:      5,
    signalBatchWindowMs:      parseIntEnv('SIGNAL_BATCH_WINDOW_MS', 10000),
    tradeDuringLunch:         process.env.TRADE_DURING_LUNCH === 'true',
  },

  indicators: {
    atrPeriod: parseIntEnv('ATR_PERIOD', 14),
  },

  session: {
    marketOpenHour:    9,
    marketOpenMinute:  30,
    blackoutEndMinute: 45,
    lunchStartHour:    12,
    lunchEndHour:      14,
    eodSweepHour:      15,
    eodSweepMinute:    45,
    hardCloseHour:     15,
    hardCloseMinute:   58,
    eodReportHour:     16,
    eodReportMinute:    5,
    screenerHour:      20,
    screenerMinute:     0,
    preMarketHour:      9,
    preMarketMinute:   15,
  },

  paths: {
    watchlist:    './data/watchlist.json',
    sessionState: './data/session_state.json',
  },

  notify: {
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL ?? null,
    telegramBotToken:  process.env.TELEGRAM_BOT_TOKEN  ?? null,
    telegramChatId:    process.env.TELEGRAM_CHAT_ID    ?? null,
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

  if (r.scaleOutTargetPct <= r.hardStopFloorPct)
    throw new Error('[SYSTEM] SCALE_OUT_TARGET_PCT must be > HARD_STOP_FLOOR_PCT');

  if (r.dailyProfitTargetPct <= 0 || r.dailyProfitTargetPct > 0.1)
    throw new Error(`[SYSTEM] DAILY_PROFIT_TARGET_PCT out of bounds (0–10%): ${r.dailyProfitTargetPct}`);
}());

export default config;
