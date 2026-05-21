import fs from 'fs/promises';
import path from 'path';
import WebSocket from 'ws';
import config from './config';
import { runScreener } from './screener';
import * as trader from './trader';
import * as riskManager from './riskManager';
import { createLogger } from './logger';
import { getESTDate, toErrorMessage } from './utils';
import { alertCritical, alertInfo, sendDailyReport } from './notifier';
import type {
  BarData,
  PendingSignal,
  SessionState,
  WsMessage,
  WsBarMessage,
  WsSuccessMessage,
  WsErrorMessage,
  DiscordField,
} from './types';
import type { SessionDataEntry } from './riskManager';
import type { AlpacaOrder } from '@alpacahq/alpaca-trade-api';

const log = createLogger('SYSTEM');

// ---------------------------------------------------------------------------
// Global session state
// ---------------------------------------------------------------------------

let ws: WebSocket | null = null;
let reconnectAttempt     = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// Set to true when circuit breaker or hard close triggers — blocks new entries
let tradingHalted = false;

// Symbols for which an entry order was emitted this session (prevents re-entry after stop-out)
const enteredSymbols = new Set<string>();

// Accumulation of 5-min intraday bars per symbol
const symbolBars = new Map<string, BarData[]>();

// Session data for EOD sweep: cumulative VWAP, session high, last bar low
const sessionData = new Map<string, SessionDataEntry>();

// Signals pending ranking before execution
const pendingSignals = new Map<string, PendingSignal>();
let signalFlushTimer: ReturnType<typeof setTimeout> | null = null;

// Equity check throttle: at most one REST /account call per minute
let lastEquityCheckMs = 0;
const EQUITY_CHECK_INTERVAL_MS = 60_000;

// Starting equity captured at boot — required for daily report
let sessionStartEquity = 0;

const WS_URL = 'wss://stream.data.alpaca.markets/v2/iex';

// ---------------------------------------------------------------------------
// EST time helpers
// ---------------------------------------------------------------------------

function msUntilESTTime(hour: number, minute: number): number {
  const now    = getESTDate();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  let diff = target.getTime() - now.getTime();
  // If target already passed today, aim for tomorrow (avoids infinite loop)
  if (diff <= 0) diff += 24 * 60 * 60 * 1000;
  return diff;
}

function isLunchPeriod(): boolean {
  const h = getESTDate().getHours();
  return h >= config.session.lunchStartHour && h < config.session.lunchEndHour;
}

function isBlackoutPeriod(): boolean {
  const est = getESTDate();
  const h   = est.getHours();
  const m   = est.getMinutes();
  return (
    h < config.session.marketOpenHour ||
    (h === config.session.marketOpenHour && m < config.session.blackoutEndMinute)
  );
}

// ---------------------------------------------------------------------------
// Session state persistence (crash recovery)
// ---------------------------------------------------------------------------

const STATE_PATH = path.resolve(config.paths.sessionState);

function getTodayDateStr(): string {
  return new Date().toISOString().split('T')[0];
}

async function saveSessionState(): Promise<void> {
  const state: SessionState = {
    date:           getTodayDateStr(),
    enteredSymbols: [...enteredSymbols],
  };
  try {
    await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
    await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    log.warn(`Cannot save session state: ${toErrorMessage(err)}`);
  }
}

async function loadSessionState(): Promise<SessionState | null> {
  try {
    const raw   = await fs.readFile(STATE_PATH, 'utf8');
    const state = JSON.parse(raw) as SessionState;
    if (state.date === getTodayDateStr()) {
      return state;
    }
  } catch {
    // No file or different date — clean start
  }
  return null;
}

// ---------------------------------------------------------------------------
// Broker state reconciliation (post-crash)
// ---------------------------------------------------------------------------

/**
 * At restart:
 *   1. Loads persisted state (enteredSymbols) if date matches today
 *   2. Queries Alpaca for open positions → adds to enteredSymbols
 *   3. Detects active trailing_stop orders → marks symbols as scaled-out in riskManager
 *      (prevents double scale-out post-crash)
 */
async function reconcileStateFromBroker(): Promise<void> {
  log.info('Reconciling state at startup...');

  const saved = await loadSessionState();
  if (saved) {
    for (const sym of saved.enteredSymbols ?? []) {
      enteredSymbols.add(sym);
    }
    log.info(`Persisted state loaded: ${enteredSymbols.size} symbol(s) already entered today`);
  }

  const [positions, orders] = await Promise.all([
    trader.getOpenPositions(),
    trader.getOpenOrders().catch((): AlpacaOrder[] => []),
  ]);

  // Any open broker position = symbol already traded this session
  for (const pos of positions) {
    enteredSymbols.add(pos.symbol);
  }

  // Active trailing stop = scale-out already executed before the crash
  const alreadyScaledOut = orders
    .filter(o => o.type === 'trailing_stop' && o.side === 'sell')
    .map(o => o.symbol);

  if (alreadyScaledOut.length > 0) {
    riskManager.markScaledOut(alreadyScaledOut);
  }

  log.info(
    `Reconciliation done: ${positions.length} broker position(s), ` +
    `${enteredSymbols.size} session symbol(s), ` +
    `${alreadyScaledOut.length} trailing stop(s) detected`,
  );

  if (positions.length > 0) {
    const fields: DiscordField[] = positions.map(p => ({
      name:   p.symbol,
      value:  `qty:${p.qty} PnL:$${parseFloat(p.unrealized_pl).toFixed(2)}`,
      inline: true,
    }));
    await alertInfo(
      'Restart with open positions',
      `${positions.length} position(s) detected at broker. Active monitoring.`,
      fields,
    );
  }
}

// ---------------------------------------------------------------------------
// Watchlist loading
// ---------------------------------------------------------------------------

async function loadWatchlist(): Promise<string[]> {
  const watchlistPath = path.resolve(config.paths.watchlist);
  try {
    const raw  = await fs.readFile(watchlistPath, 'utf8');
    const data = JSON.parse(raw) as { symbols: Array<{ symbol: string }>; generatedAt: string };
    const symbols = data.symbols.map(s => s.symbol);
    log.info(`Watchlist loaded: ${symbols.length} symbols (generated ${data.generatedAt})`);
    return symbols;
  } catch {
    log.info('Watchlist missing — running screener...');
    const watchlist = await runScreener();
    return watchlist.symbols.map(s => s.symbol);
  }
}

// ---------------------------------------------------------------------------
// Intraday cumulative VWAP
// ---------------------------------------------------------------------------

function computeVwap(bars: BarData[]): number | null {
  if (bars.length === 0) return null;
  const totalVolume = bars.reduce((a, b) => a + b.volume, 0);
  if (totalVolume === 0) return null;
  const tpv = bars.reduce((sum, b) => sum + ((b.high + b.low + b.close) / 3) * b.volume, 0);
  return tpv / totalVolume;
}

// ---------------------------------------------------------------------------
// Signal evaluation (VWAP breakout + volume conviction filter)
// ---------------------------------------------------------------------------

/**
 * Conditions required for a signal to qualify:
 *   1. Trading not halted
 *   2. No entry already emitted for this symbol this session
 *   3. Lunch filter: blocked 12:00–14:00 EST if tradeDuringLunch = false
 *   4. VWAP breakout: prev_close <= vwap AND current_close > vwap (strict transition)
 *   5. Volume conviction: bar_volume > volumeBreakoutMultiplier × avg(5 previous bars)
 *
 * Qualified signals are stored in pendingSignals with their Momentum Score.
 * Execution is delegated to flushPendingSignals().
 */
function evaluateSignal(symbol: string, latestBar: BarData): void {
  if (tradingHalted)              return;
  if (enteredSymbols.has(symbol)) return;

  if (!config.entry.tradeDuringLunch && isLunchPeriod()) return;

  const bars = symbolBars.get(symbol) ?? [];
  if (bars.length < config.entry.minBarsForVolumeAvg + 1) return;

  const vwap = computeVwap(bars);
  if (vwap === null) return;

  const currentPrice = latestBar.close;
  const prevBar      = bars[bars.length - 2];

  const vwapBreakout = prevBar.close <= vwap && currentPrice > vwap;
  if (!vwapBreakout) return;

  const recentBars = bars.slice(-(config.entry.minBarsForVolumeAvg + 1), -1);
  if (recentBars.length < config.entry.minBarsForVolumeAvg) return;

  const avgVolume      = recentBars.reduce((sum, b) => sum + b.volume, 0) / recentBars.length;
  const volumeRequired = avgVolume * config.entry.volumeBreakoutMultiplier;

  if (latestBar.volume <= volumeRequired) {
    log.info(
      `${symbol}: VWAP breakout without volume conviction ` +
      `(${latestBar.volume.toLocaleString()} vs ${Math.round(volumeRequired).toLocaleString()} required) — ignored`,
    );
    return;
  }

  // Momentum Score = breakout volume × VWAP deviation %
  // Higher score = stronger breakout on larger volume
  const vwapDeviation = (currentPrice - vwap) / vwap;
  const momentumScore = latestBar.volume * vwapDeviation;

  log.info(
    `${symbol}: qualified signal — ` +
    `price $${currentPrice.toFixed(2)} | VWAP $${vwap.toFixed(2)} | ` +
    `deviation ${(vwapDeviation * 100).toFixed(2)}% | vol ×${(latestBar.volume / avgVolume).toFixed(1)} | ` +
    `score ${Math.round(momentumScore).toLocaleString()} → queued`,
  );

  // Overwrites any previous entry for this symbol (more recent signal = more relevant)
  pendingSignals.set(symbol, { symbol, score: momentumScore, barData: latestBar, vwap, avgVolume });
  schedulePendingSignalFlush();
}

// ---------------------------------------------------------------------------
// Debounced batch execution — ranks signals by Momentum Score
// ---------------------------------------------------------------------------

function schedulePendingSignalFlush(): void {
  if (signalFlushTimer) clearTimeout(signalFlushTimer);
  signalFlushTimer = setTimeout((): void => {
    flushPendingSignals().catch((err: unknown) => {
      log.error(`flushPendingSignals error: ${toErrorMessage(err)}`);
    });
  }, config.entry.signalBatchWindowMs);
}

/**
 * After the batch window:
 *   - Retrieves the number of available slots
 *   - Ranks pending signals by descending score
 *   - Executes the N best (N = available slots)
 *   - Rejects the rest with an explicit log
 */
async function flushPendingSignals(): Promise<void> {
  signalFlushTimer = null;

  if (pendingSignals.size === 0) return;

  // Double check: tradingHalted (set after await) AND circuitBreakerTriggered
  // (set synchronously before any await in checkCircuitBreaker) — fixes race condition
  if (tradingHalted || riskManager.isCircuitBreakerTriggered()) {
    log.info(`Flush cancelled: trading halted (${pendingSignals.size} signal(s) dropped)`);
    pendingSignals.clear();
    return;
  }

  // Opening blackout 09:30–09:45: defer execution until market settles
  if (isBlackoutPeriod()) {
    log.info(`Blackout active (09:30–09:45) — ${pendingSignals.size} signal(s) deferred`);
    schedulePendingSignalFlush();
    return;
  }

  let currentPositions: Awaited<ReturnType<typeof trader.getOpenPositions>>;
  try {
    currentPositions = await trader.getOpenPositions();
  } catch (err) {
    log.error(`Flush impossible: API error on positions — ${toErrorMessage(err)}`);
    pendingSignals.clear();
    return;
  }

  const availableSlots = config.risk.maxPositions - currentPositions.length;

  // Filter symbols that entered during the batch window (race condition guard)
  const candidates = [...pendingSignals.values()].filter(s => !enteredSymbols.has(s.symbol));

  if (availableSlots <= 0 || candidates.length === 0) {
    log.info(
      `Flush — ${candidates.length} candidate(s), ` +
      `${currentPositions.length}/${config.risk.maxPositions} positions — no slot available`,
    );
    pendingSignals.clear();
    return;
  }

  const ranked    = candidates.sort((a, b) => b.score - a.score);
  const toExecute = ranked.slice(0, availableSlots);
  const rejected  = ranked.slice(availableSlots);

  log.info(
    `Flush — ${candidates.length} candidate(s) | ` +
    `${toExecute.length} selected | ${rejected.length} rejected | ` +
    `slots: ${availableSlots}/${config.risk.maxPositions}`,
  );

  rejected.forEach(s => {
    log.info(`  rejected  ${s.symbol.padEnd(6)} | score ${Math.round(s.score).toLocaleString()}`);
  });

  for (const signal of toExecute) {
    const { symbol, barData, score, vwap } = signal;

    log.info(
      `  executing ${symbol.padEnd(6)} | score ${Math.round(score).toLocaleString()} ` +
      `| VWAP deviation ${(((barData.close - vwap) / vwap) * 100).toFixed(2)}% ` +
      `| price $${barData.close.toFixed(2)}`,
    );

    try {
      const settledCash = await trader.getSettledCash();
      const { qty, stopLossPrice } = await riskManager.computePositionSize(
        symbol,
        barData.close,
        settledCash,
      );

      if (qty < 1) {
        log.warn(`${symbol}: position size 0 — ignored`);
        continue;
      }

      await trader.placeBracketOrder(symbol, qty, barData.close, stopLossPrice);
      enteredSymbols.add(symbol);
      await saveSessionState();
    } catch (err) {
      log.error(`${symbol}: order failed — ${toErrorMessage(err)}`);
    }
  }

  pendingSignals.clear();
}

// ---------------------------------------------------------------------------
// 5-minute bar event handler
// ---------------------------------------------------------------------------

async function handleBarEvent(bar: WsBarMessage): Promise<void> {
  const symbol  = bar.S;
  const barData: BarData = {
    open:      bar.o,
    high:      bar.h,
    low:       bar.l,
    close:     bar.c,
    volume:    bar.v,
    timestamp: bar.t,
  };

  let bars = symbolBars.get(symbol);
  if (!bars) {
    bars = [];
    symbolBars.set(symbol, bars);
  }
  bars.push(barData);

  // Memory bound: keep only what's needed for VWAP + avg volume computation
  const maxBars = 80;
  if (bars.length > maxBars) bars.splice(0, bars.length - maxBars);

  // Update session data for EOD sweep
  const currentVwap = computeVwap(bars);
  if (currentVwap !== null) {
    const sessionHigh = bars.reduce((max, b) => Math.max(max, b.high), -Infinity);
    sessionData.set(symbol, {
      vwap:       currentVwap,
      high:       sessionHigh,
      lastBarLow: barData.low,
    });
  }

  // Active position management only for symbols entered this session
  // Avoids ~3,900 getPosition() 404 calls/day on non-portfolio symbols
  if (enteredSymbols.has(symbol)) {
    await riskManager.handlePositionUpdate(symbol, barData.close);
  }

  // Circuit breaker equity check — throttled to 1 REST call/minute max
  if (!tradingHalted) {
    const now = Date.now();
    if (now - lastEquityCheckMs >= EQUITY_CHECK_INTERVAL_MS) {
      lastEquityCheckMs = now;
      try {
        const equity    = await trader.getAccountEquity();
        const triggered = await riskManager.checkCircuitBreaker(equity);
        if (triggered) {
          tradingHalted = true;
          const pnlPct = (((equity - sessionStartEquity) / sessionStartEquity) * 100).toFixed(2);
          log.info(`Trading halted — daily target +${pnlPct}% reached`);
          alertCritical(
            'Daily circuit breaker triggered',
            `Target +${config.risk.dailyProfitTargetPct * 100}% reached. All positions liquidated. No new trades today.`,
            [
              { name: 'PnL',    value: `+${pnlPct}%`,          inline: true },
              { name: 'Equity', value: `$${equity.toFixed(2)}`, inline: true },
            ],
          ).catch(() => {});
          return;
        }
      } catch (err) {
        log.error(`Circuit breaker check error: ${toErrorMessage(err)}`);
      }
    }
  }

  // Signal evaluation is synchronous — execution is deferred to flushPendingSignals()
  evaluateSignal(symbol, barData);
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

function buildSubscribeMessage(symbols: string[]): string {
  return JSON.stringify({ action: 'subscribe', bars: symbols });
}

function isWsBarMessage(msg: WsMessage): msg is WsBarMessage {
  return msg.T === 'b';
}

function isWsSuccessMessage(msg: WsMessage): msg is WsSuccessMessage {
  return msg.T === 'success';
}

function isWsErrorMessage(msg: WsMessage): msg is WsErrorMessage {
  return msg.T === 'error';
}

async function handleWsMessage(raw: WebSocket.RawData, symbols: string[]): Promise<void> {
  let messages: WsMessage[];
  try {
    const text   = Buffer.isBuffer(raw) ? raw.toString('utf8') : Buffer.from(raw as ArrayBuffer).toString('utf8');
    const parsed = JSON.parse(text) as unknown;
    messages     = Array.isArray(parsed) ? (parsed as WsMessage[]) : [parsed as WsMessage];
  } catch {
    return;
  }

  for (const msg of messages) {
    if (isWsSuccessMessage(msg) && msg.msg === 'authenticated') {
      log.info(`WebSocket authenticated — subscribing to ${symbols.length} symbols`);
      ws?.send(buildSubscribeMessage(symbols));
    }

    if (isWsBarMessage(msg)) {
      await handleBarEvent(msg);
    }

    if (isWsErrorMessage(msg)) {
      log.warn(`WebSocket error: code ${msg.code} — ${msg.msg}`);
    }
  }
}

function connectWebSocket(symbols: string[]): void {
  const authMessage = JSON.stringify({
    action: 'auth',
    key:    config.alpaca.keyId,
    secret: config.alpaca.secretKey,
  });

  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    reconnectAttempt = 0;
    log.info('WebSocket connected — authenticating...');
    ws?.send(authMessage);
  });

  ws.on('message', (raw: WebSocket.RawData) => {
    handleWsMessage(raw, symbols).catch((err: unknown) => {
      log.error(`WebSocket message handler error: ${toErrorMessage(err)}`);
    });
  });

  ws.on('close', (code: number) => {
    log.warn(`WebSocket closed (code ${code}) — reconnection scheduled...`);
    scheduleReconnect(symbols);
  });

  ws.on('error', (err: Error) => {
    log.error(`WebSocket error: ${err.message}`);
  });
}

function scheduleReconnect(symbols: string[]): void {
  if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    log.error('Maximum reconnect attempts reached — giving up');
    alertCritical(
      'WebSocket unrecoverable',
      `${MAX_RECONNECT_ATTEMPTS} reconnect attempts exhausted. Bot no longer receiving market data. Manual intervention required.`,
    ).catch(() => {});
    return;
  }
  reconnectAttempt++;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempt - 1), 60000);
  log.warn(
    `Reconnect ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS} in ${Math.round(delay / 1000)}s`,
  );
  setTimeout(() => connectWebSocket(symbols), delay);
}

// ---------------------------------------------------------------------------
// Scheduled time-based actions
// ---------------------------------------------------------------------------

function scheduleEodSweep(): void {
  const ms = msUntilESTTime(config.session.eodSweepHour, config.session.eodSweepMinute);
  log.info(`EOD sweep 15:45 scheduled in ${Math.round(ms / 1000 / 60)} minutes`);
  setTimeout((): void => {
    // Block new entries from 15:45 onwards
    tradingHalted = true;
    riskManager.runEodSweep(sessionData).catch((err: unknown) => {
      log.error(`EOD sweep error: ${toErrorMessage(err)}`);
    });
    scheduleEodSweep();
  }, ms);
}

function scheduleHardClose(): void {
  const ms = msUntilESTTime(config.session.hardCloseHour, config.session.hardCloseMinute);
  log.info(`Hard close 15:58 scheduled in ${Math.round(ms / 1000 / 60)} minutes`);
  setTimeout((): void => {
    riskManager.runHardClose().catch((err: unknown) => {
      log.error(`Hard close error: ${toErrorMessage(err)}`);
    });
    scheduleHardClose();
  }, ms);
}

// ---------------------------------------------------------------------------
// Daily lifecycle — three independent crons
// ---------------------------------------------------------------------------

// 16:05 EST: market fully closed → send EOD report (state untouched)
function scheduleEodReport(): void {
  const ms = msUntilESTTime(config.session.eodReportHour, config.session.eodReportMinute);
  log.info(`EOD report scheduled in ${Math.round(ms / 1000 / 60)} minutes`);
  setTimeout((): void => {
    log.info('Sending EOD report...');
    trader.getAccountEquity()
      .then(async (endEquity) => {
        await sendDailyReport({
          startEquity:         sessionStartEquity,
          endEquity,
          tradesEntered:       enteredSymbols.size,
          circuitBreakerFired: riskManager.isCircuitBreakerTriggered(),
          symbols:             [...enteredSymbols],
        });
      })
      .catch(() => {});
    scheduleEodReport();
  }, ms);
}

// 20:00 EST: full session state reset + screener for D+1 + WebSocket refresh
function scheduleDailyReset(): void {
  const ms = msUntilESTTime(config.session.screenerHour, config.session.screenerMinute);
  log.info(`Daily reset + screener scheduled in ${Math.round(ms / 1000 / 60)} minutes`);
  setTimeout((): void => {
    log.info('Daily reset 20:00 — purging session state for D+1...');

    fs.unlink(path.resolve(config.paths.sessionState)).catch(() => {});

    tradingHalted     = false;
    lastEquityCheckMs = 0;
    enteredSymbols.clear();
    pendingSignals.clear();
    if (signalFlushTimer) {
      clearTimeout(signalFlushTimer);
      signalFlushTimer = null;
    }
    symbolBars.clear();
    sessionData.clear();

    trader.getAccountEquity()
      .then((newEquity) => {
        sessionStartEquity = newEquity;
        riskManager.initDailyBaseline(newEquity);
        log.info(`New equity baseline: $${newEquity.toFixed(2)}`);
      })
      .catch(() => {
        log.warn('Daily reset: cannot read equity — baseline not updated');
      });

    runScreener()
      .then(watchlist => {
        const newSymbols = watchlist.symbols.map(s => s.symbol);
        log.info(`Screener done — ${newSymbols.length} symbol(s) ready for next session`);
        if (newSymbols.length > 0) {
          // Tear down existing connection (if any) and reconnect with fresh symbols
          if (ws) {
            ws.removeAllListeners();
            ws.close();
            ws = null;
          }
          reconnectAttempt = 0;
          connectWebSocket(newSymbols);
        } else {
          log.warn('Screener returned 0 symbols — WebSocket not reconnected');
        }
      })
      .catch((err: unknown) => {
        log.error(`Post-session screener failed: ${toErrorMessage(err)}`);
      });

    scheduleDailyReset();
  }, ms);
}

// 09:15 EST: pre-market broker reconciliation (post-crash / post-weekend safety net)
function schedulePreMarketReconciliation(): void {
  const ms = msUntilESTTime(config.session.preMarketHour, config.session.preMarketMinute);
  log.info(`Pre-market reconciliation scheduled in ${Math.round(ms / 1000 / 60)} minutes`);
  setTimeout((): void => {
    log.info('Pre-market reconciliation 09:15...');
    reconcileStateFromBroker().catch((err: unknown) => {
      log.error(`Pre-market reconciliation error: ${toErrorMessage(err)}`);
    });
    schedulePreMarketReconciliation();
  }, ms);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log.info('Initializing trading bot...');

  const symbols = await loadWatchlist();

  // Always arm all crons — they must fire even on empty-watchlist days
  scheduleEodSweep();
  scheduleHardClose();
  scheduleEodReport();
  scheduleDailyReset();
  schedulePreMarketReconciliation();

  if (symbols.length === 0) {
    // No symbols today: keep process alive so the 20:00 screener can populate the
    // watchlist and reconnect the WebSocket for the next session.
    log.warn('Empty watchlist — no trades today. Waiting for 20:00 screener...');
    return;
  }

  // Capture starting equity for the daily circuit breaker
  sessionStartEquity = await trader.getAccountEquity();
  riskManager.initDailyBaseline(sessionStartEquity);

  // Reconcile state from broker (protects against mid-session crashes)
  await reconcileStateFromBroker();

  connectWebSocket(symbols);

  log.info(`Bot active — monitoring ${symbols.length} symbols`);
  await alertInfo(
    'Bot started',
    `Monitoring ${symbols.length} symbols | Equity: $${sessionStartEquity.toFixed(2)}`,
  ).catch(() => {});

}

// ---------------------------------------------------------------------------
// Graceful shutdown — saves state before PM2 kills the process
// ---------------------------------------------------------------------------

async function gracefulShutdown(signal: string): Promise<void> {
  log.warn(`Signal ${signal} received — saving state and shutting down`);
  await saveSessionState().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => { gracefulShutdown('SIGTERM').catch(() => {}); });
process.on('SIGINT',  () => { gracefulShutdown('SIGINT').catch(() => {}); });

main().catch(async (err: unknown) => {
  const message = toErrorMessage(err);
  log.error(`Fatal error at startup: ${message}`);
  await alertCritical('Fatal startup error', message).catch(() => {});
  process.exit(1);
});
