import { parseFloatEnv, parseIntEnv, parseStringEnv, requireEnv } from './env';

function parseFeed(envKey: string, raw: string | undefined, fallback: 'iex' | 'sip'): 'iex' | 'sip' {
  const value = (raw ?? fallback).trim().toLowerCase();
  if (value === 'iex' || value === 'sip') return value;
  throw new Error(`[SYSTEM] ${envKey} must be iex|sip: "${raw ?? ''}"`);
}

const scanHour = parseIntEnv('SCAN_HOUR', 16);
const scanMinute = parseIntEnv('SCAN_MINUTE', 30);

const config = {
  alpaca: {
    keyId: requireEnv('ALPACA_KEY_ID'),
    secretKey: requireEnv('ALPACA_SECRET_KEY'),
    baseUrl: process.env.ALPACA_BASE_URL ?? 'https://paper-api.alpaca.markets',
    dataUrl: process.env.ALPACA_DATA_URL ?? 'https://data.alpaca.markets',
    dataFeed: parseFeed('ALPACA_DATA_FEED', process.env.ALPACA_DATA_FEED, 'sip'),
    /**
     * A non-realtime SIP plan rejects any window that ends inside the last
     * 15 minutes. One extra minute absorbs clock skew.
     */
    sipDelayMs: parseIntEnv('SIP_DELAY_MS', 16 * 60_000),
    paper: true as const,
  },

  /**
   * Research scripts still read these keys. They are not the swing radar's
   * own universe (that lives under `universe`).
   */
  screener: {
    minClosePrice: parseFloatEnv('MIN_CLOSE_PRICE', 5),
    maxClosePrice: parseFloatEnv('MAX_CLOSE_PRICE', 100),
    eveningScreenerEnabled: process.env.EVENING_SCREENER_ENABLED !== 'false',
  },

  premarket: {
    poolMinPrevDollarVolume: parseFloatEnv('POOL_SIP_MIN_DOLLAR_VOLUME', 5_000_000),
  },

  session: {
    screenerHour: scanHour,
    screenerMinute: scanMinute,
    preMarketHour: parseIntEnv('PREMARKET_HOUR', 9),
    preMarketMinute: parseIntEnv('PREMARKET_MINUTE', 15),
  },

  universe: {
    minClosePrice: parseFloatEnv('SWING_MIN_PRICE', 10),
    minDollarVolume: parseFloatEnv('SWING_MIN_DOLLAR_VOLUME', 20_000_000),
    dollarVolumeDays: parseIntEnv('SWING_DOLLAR_VOLUME_DAYS', 20),
    minAdrPct: parseFloatEnv('SWING_MIN_ADR_PCT', 4),
    adrLookbackDays: parseIntEnv('SWING_ADR_LOOKBACK_DAYS', 14),
    historySessions: parseIntEnv('SWING_HISTORY_SESSIONS', 300),
    allowedExchanges: ['NYSE', 'NASDAQ'] as readonly string[],
    benchmarks: ['SPY', 'QQQ'] as readonly string[],
  },

  weekly: {
    sma10Period: 10,
    sma30Period: 30,
    sma40Period: 40,
    slopeWeeks: 4,
    swingWing: 2,
    zoneTolerancePct: 0.02,
    tightWeekTolerancePct: 0.015,
    overheadBufferPct: 0.015,
    minRoomToResistanceR: parseFloatEnv('SWING_MIN_ROOM_TO_RESISTANCE_R', 2.0),
  },

  trendTemplate: {
    sma50Period: 50,
    sma150Period: 150,
    sma200Period: 200,
    sma200SlopeBars: 20,
    minRsRating: parseFloatEnv('SWING_MIN_RS', 70),
    low52wMultiple: 1.30,
    high52wFloor: 0.75,
    weekSessions: 252,
  },

  regime: {
    distributionWindow: 25,
    distributionDeclinePct: 0.002,
    distributionRallyResetPct: 0.05,
    pressureDistributionMin: 5,
    correctionDistributionMin: 7,
  },

  patterns: {
    swingWing: 2,
    maxDistanceBelowPct: 0.05,
    maxExtensionPct: 0.05,
    minBreakoutRvol: 1.5,
    rvolAvgDays: 14,
    maxRiskPct: 0.08,
    vcpMinBaseBars: 15,
    vcpMaxBaseBars: 130,
    vcpMinContractions: 2,
    vcpMaxContractions: 5,
    vcpContractionRatio: 0.80,
    vcpMaxLastContraction: 0.10,
    vcpDryUpRatio: 0.70,
    cupMinBars: 35,
    cupMaxBars: 325,
    cupMinDepthPct: 0.12,
    cupMaxDepthPct: 0.35,
    handleMinBars: 5,
    handleMaxBars: 25,
    handleMaxRetracePct: 0.12,
    flagImpulseMinPct: 0.30,
    flagImpulseMaxBars: 40,
    flagMinBars: 5,
    flagMaxBars: 25,
    flagVolDryUpRatio: 0.60,
    flagAdrRiskMultiple: 1.2,
    flatBaseBars: 25,
    flatBaseAtrShort: 10,
    flatBaseAtrRef: 30,
    flatBaseAtrCompressionRatio: 0.70,
    flatBaseMaxRangePct: 0.12,
    reversalMaxAgeBars: 2,
  },

  episodicPivot: {
    minGapPct: parseFloatEnv('EP_MIN_GAP_PCT', 0.10),
    minRvol: parseFloatEnv('EP_MIN_RVOL', 3),
    rvolAvgDays: 50,
    minCloseLocation: 0.65,
    newsLookbackHours: parseIntEnv('SENTIMENT_LOOKBACK_HOURS', 48),
  },

  referenceSizing: {
    capitalUsd: parseFloatEnv('REFERENCE_CAPITAL_USD', 100_000),
    riskPerTradePct: parseFloatEnv('REFERENCE_RISK_PCT', 0.01),
    maxPositionPct: parseFloatEnv('REFERENCE_MAX_POSITION_PCT', 0.20),
    minRiskRewardRatio: 2,
  },

  sentiment: {
    enabled: process.env.SENTIMENT_FILTER_ENABLED === 'true',
    lookbackHours: parseIntEnv('SENTIMENT_LOOKBACK_HOURS', 48),
    maxHeadlinesPerSymbol: parseIntEnv('SENTIMENT_MAX_HEADLINES', 25),
    fetchConcurrency: parseIntEnv('SENTIMENT_FETCH_CONCURRENCY', 5),
  },

  policyMonitor: {
    secUserAgent: parseStringEnv(
      'POLICY_MONITOR_SEC_USER_AGENT',
      'trading-bot research (personal)',
    ),
  },

  paths: {
    watchlist: './data/watchlist.json',
    heartbeat: parseStringEnv('HEARTBEAT_PATH', './data/heartbeat.json'),
    eodCache: parseStringEnv('EOD_CACHE_PATH', './data/eod'),
    reports: parseStringEnv('SWING_REPORTS_PATH', './data/reports'),
  },

  health: {
    heartbeatIntervalMs: parseIntEnv('HEARTBEAT_INTERVAL_MS', 20_000),
  },

  notify: {
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL ?? null,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? null,
    telegramChatId: process.env.TELEGRAM_CHAT_ID ?? null,
  },
};

(function validateConfig(): void {
  const u = config.universe;
  if (u.minClosePrice <= 0) {
    throw new Error(`[SYSTEM] SWING_MIN_PRICE must be > 0: ${u.minClosePrice}`);
  }
  if (u.minDollarVolume <= 0) {
    throw new Error(`[SYSTEM] SWING_MIN_DOLLAR_VOLUME must be > 0: ${u.minDollarVolume}`);
  }
  if (u.historySessions < config.trendTemplate.weekSessions) {
    throw new Error(
      `[SYSTEM] SWING_HISTORY_SESSIONS must be >= 252: ${u.historySessions}`,
    );
  }
  if (scanHour < 0 || scanHour > 23 || scanMinute < 0 || scanMinute > 59) {
    throw new Error(`[SYSTEM] SCAN_HOUR/SCAN_MINUTE out of range: ${scanHour}:${scanMinute}`);
  }
  const s = config.referenceSizing;
  if (s.capitalUsd <= 0 || s.riskPerTradePct <= 0 || s.maxPositionPct <= 0) {
    throw new Error('[SYSTEM] REFERENCE_CAPITAL_USD, REFERENCE_RISK_PCT and REFERENCE_MAX_POSITION_PCT must be > 0');
  }
  if (config.sentiment.lookbackHours < 1 || config.sentiment.lookbackHours > 168) {
    throw new Error(
      `[SYSTEM] SENTIMENT_LOOKBACK_HOURS out of bounds (1–168): ${config.sentiment.lookbackHours}`,
    );
  }
})();

export default config;
