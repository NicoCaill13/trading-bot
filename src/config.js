'use strict';

require('dotenv').config();

function requireEnv(key) {
  const value = process.env[key];
  if (!value) {
    throw new Error(`[SYSTEM] Missing required environment variable: ${key}`);
  }
  return value;
}

function parseFloat_env(key, defaultValue) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = parseFloat(raw);
  if (isNaN(parsed)) throw new Error(`[SYSTEM] Invalid float for env var ${key}: "${raw}"`);
  return parsed;
}

function parseInt_env(key, defaultValue) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) throw new Error(`[SYSTEM] Invalid integer for env var ${key}: "${raw}"`);
  return parsed;
}

const config = {
  alpaca: {
    keyId: requireEnv('ALPACA_KEY_ID'),
    secretKey: requireEnv('ALPACA_SECRET_KEY'),
    baseUrl: process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets',
    dataUrl: process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets',
    paper: true,
  },

  risk: {
    maxPositions: parseInt_env('MAX_POSITIONS', 5),
    maxPositionPct: parseFloat_env('MAX_POSITION_PCT', 0.20),
    stopLossPct: parseFloat_env('STOP_LOSS_PCT', 0.015),
    scaleOutTargetPct: parseFloat_env('SCALE_OUT_TARGET_PCT', 0.02),
    trailingStopPct: parseFloat_env('TRAILING_STOP_PCT', 0.015),
  },

  screener: {
    minRelativeVolume: parseFloat_env('MIN_RELATIVE_VOLUME', 2.0),
    minGapUpPct: parseFloat_env('MIN_GAP_UP_PCT', 0.02),
    watchlistMaxSize: parseInt_env('WATCHLIST_MAX_SIZE', 50),
    relativeStrengthLookbackDays: 20,
    volumeAverageDays: 10,
  },

  indicators: {
    atrPeriod: parseInt_env('ATR_PERIOD', 14),
    rsiPeriod: parseInt_env('RSI_PERIOD', 14),
  },

  session: {
    // EST offsets (UTC-5 standard, UTC-4 DST — handled dynamically at call site)
    marketOpenHour: 9,
    marketOpenMinute: 30,
    blackoutEndMinute: 45,     // no trades before 9:45 EST
    eodSweepHour: 15,
    eodSweepMinute: 45,        // end-of-day risk sweep at 15:45 EST
    marketCloseHour: 16,
  },

  paths: {
    watchlist: './data/watchlist.json',
  },
};

module.exports = config;
