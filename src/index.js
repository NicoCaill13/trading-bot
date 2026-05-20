'use strict';

const fs = require('fs').promises;
const path = require('path');
const WebSocket = require('ws');
const { RSI, VWAP } = require('technicalindicators');
const config = require('./config');
const { runScreener } = require('./screener');
const trader = require('./trader');
const riskManager = require('./risk_manager');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let ws = null;
let reconnectAttempt = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// Per-symbol intraday state: bars accumulation for RSI and VWAP
const symbolBars = new Map();    // symbol -> [{ open, high, low, close, volume, timestamp }]
const sessionData = new Map();   // symbol -> { vwap, high } updated on each bar

// Alpaca WebSocket stream URL
const WS_URL = 'wss://stream.data.alpaca.markets/v2/iex';

// ---------------------------------------------------------------------------
// Utility: EST time helpers
// ---------------------------------------------------------------------------

function getESTDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

function msUntilESTTime(hour, minute) {
  const now = getESTDate();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  const diff = target.getTime() - now.getTime();
  return diff > 0 ? diff : 0;
}

// ---------------------------------------------------------------------------
// Watchlist loader
// ---------------------------------------------------------------------------

async function loadWatchlist() {
  const watchlistPath = path.resolve(config.paths.watchlist);
  try {
    const raw = await fs.readFile(watchlistPath, 'utf8');
    const data = JSON.parse(raw);
    const symbols = data.symbols.map(s => s.symbol);
    console.log(`[SYSTEM] Watchlist loaded: ${symbols.length} symbols (generated ${data.generatedAt})`);
    return symbols;
  } catch (err) {
    console.log(`[SYSTEM] No watchlist found at ${watchlistPath} — running screener now...`);
    const watchlist = await runScreener();
    return watchlist.symbols.map(s => s.symbol);
  }
}

// ---------------------------------------------------------------------------
// Indicator calculations on live bar data
// ---------------------------------------------------------------------------

function computeVwap(bars) {
  if (bars.length === 0) return null;
  const typicalPrices = bars.map(b => (b.high + b.low + b.close) / 3);
  const volumes = bars.map(b => b.volume);
  const totalVolume = volumes.reduce((a, v) => a + v, 0);
  if (totalVolume === 0) return null;
  const tpv = typicalPrices.reduce((sum, tp, i) => sum + tp * volumes[i], 0);
  return tpv / totalVolume;
}

function computeRsi(bars, period) {
  if (bars.length < period + 1) return null;
  const closes = bars.map(b => b.close);
  const values = RSI.calculate({ values: closes, period });
  return values.length > 0 ? values[values.length - 1] : null;
}

// ---------------------------------------------------------------------------
// Trade signal evaluation
// ---------------------------------------------------------------------------

async function evaluateSignal(symbol, latestBar) {
  const bars = symbolBars.get(symbol) || [];
  const vwap = computeVwap(bars);
  const rsi = computeRsi(bars, config.indicators.rsiPeriod);

  if (vwap === null || rsi === null) return;

  const currentPrice = latestBar.close;
  const prevBar = bars.length >= 2 ? bars[bars.length - 2] : null;

  // VWAP breakout: current close crosses above VWAP, previous close was below
  const vwapBreakout = prevBar
    ? prevBar.close <= vwap && currentPrice > vwap
    : currentPrice > vwap;

  if (!vwapBreakout) return;
  if (rsi >= 70) {
    console.log(`[SYSTEM] ${symbol}: VWAP breakout detected but RSI overbought (${rsi.toFixed(1)}) — signal ignored`);
    return;
  }

  console.log(`[SYSTEM] ${symbol}: VWAP breakout confirmed — price $${currentPrice.toFixed(2)} VWAP $${vwap.toFixed(2)} RSI ${rsi.toFixed(1)}`);

  try {
    const settledCash = await trader.getSettledCash();
    const { qty, stopLossPrice } = await riskManager.computePositionSize(symbol, currentPrice, settledCash);

    if (qty < 1) {
      console.log(`[SYSTEM] ${symbol}: position size computed to 0 — skipping`);
      return;
    }

    await trader.placeBracketOrder(symbol, qty, currentPrice, stopLossPrice);
  } catch (err) {
    console.log(`[SYSTEM] ${symbol}: order failed — ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// WebSocket connection management
// ---------------------------------------------------------------------------

function buildWsSubscribeMessage(symbols) {
  return JSON.stringify({
    action: 'subscribe',
    bars: symbols,
  });
}

function connectWebSocket(symbols) {
  const authMessage = JSON.stringify({
    action: 'auth',
    key: config.alpaca.keyId,
    secret: config.alpaca.secretKey,
  });

  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    reconnectAttempt = 0;
    console.log('[SYSTEM] WebSocket connected — authenticating...');
    ws.send(authMessage);
  });

  ws.on('message', async (raw) => {
    let messages;
    try {
      messages = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!Array.isArray(messages)) messages = [messages];

    for (const msg of messages) {
      if (msg.T === 'success' && msg.msg === 'authenticated') {
        console.log(`[SYSTEM] WebSocket authenticated — subscribing to ${symbols.length} symbols`);
        ws.send(buildWsSubscribeMessage(symbols));
      }

      if (msg.T === 'b') {
        // 5-minute bar event
        await handleBarEvent(msg);
      }

      if (msg.T === 'error') {
        console.log(`[SYSTEM] WebSocket error message: ${msg.code} — ${msg.msg}`);
      }
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[SYSTEM] WebSocket closed (code ${code}) — scheduling reconnect...`);
    scheduleReconnect(symbols);
  });

  ws.on('error', (err) => {
    console.log(`[SYSTEM] WebSocket error: ${err.message}`);
  });
}

function scheduleReconnect(symbols) {
  if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    console.log('[SYSTEM] Max reconnection attempts reached — halting reconnect loop');
    return;
  }
  reconnectAttempt++;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempt - 1), 60000);
  console.log(`[SYSTEM] Reconnect attempt ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
  setTimeout(() => connectWebSocket(symbols), delay);
}

// ---------------------------------------------------------------------------
// Bar event handler
// ---------------------------------------------------------------------------

async function handleBarEvent(bar) {
  const symbol = bar.S;
  const barData = {
    open: bar.o,
    high: bar.h,
    low: bar.l,
    close: bar.c,
    volume: bar.v,
    timestamp: bar.t,
  };

  if (!symbolBars.has(symbol)) {
    symbolBars.set(symbol, []);
  }
  const bars = symbolBars.get(symbol);
  bars.push(barData);

  // Keep memory bounded to RSI lookback + buffer
  const maxBars = config.indicators.rsiPeriod + 50;
  if (bars.length > maxBars) bars.splice(0, bars.length - maxBars);

  // Update session high and VWAP for EOD sweep
  const currentVwap = computeVwap(bars);
  const sessionHigh = Math.max(...bars.map(b => b.high));
  if (currentVwap !== null) {
    sessionData.set(symbol, { vwap: currentVwap, high: sessionHigh });
  }

  // Active position management (scale-out + trailing)
  await riskManager.handlePositionUpdate(symbol, barData.close);

  // Entry signal evaluation
  await evaluateSignal(symbol, barData);
}

// ---------------------------------------------------------------------------
// EOD sweep scheduler
// ---------------------------------------------------------------------------

function scheduleEodSweep() {
  const ms = msUntilESTTime(
    config.session.eodSweepHour,
    config.session.eodSweepMinute,
  );
  console.log(`[SYSTEM] EOD sweep scheduled in ${Math.round(ms / 1000 / 60)} minutes`);
  setTimeout(async () => {
    await riskManager.runEodSweep(sessionData);
    // Re-schedule for next trading day
    scheduleEodSweep();
  }, ms || 1000);
}

// ---------------------------------------------------------------------------
// Boot sequence
// ---------------------------------------------------------------------------

async function main() {
  console.log('[SYSTEM] Trading bot initializing...');

  const symbols = await loadWatchlist();

  if (symbols.length === 0) {
    console.log('[SYSTEM] Empty watchlist — nothing to trade today');
    return;
  }

  scheduleEodSweep();
  connectWebSocket(symbols);

  console.log(`[SYSTEM] Listening to ${symbols.length} symbols via WebSocket`);
}

main().catch(err => {
  console.log(`[SYSTEM] Fatal error during boot: ${err.message}`);
  process.exit(1);
});
