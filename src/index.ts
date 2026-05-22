import fs from 'fs/promises';
import path from 'path';
import WebSocket from 'ws';
import config, { getTimedecaySlotLimits } from './config';
import { runScreener } from './screener';
import { runPremarketScreener } from './premarket_screener';
import * as signalQueue from './signalQueue';
import * as trader from './trader';
import * as riskManager from './riskManager';
import * as journalManager from './journalManager';
import { runPostMortem } from './analyzer';
import alpaca from './alpacaClient';
import { createLogger } from './logger';
import { getESTDate, toErrorMessage } from './utils';
import { alertCritical, alertInfo, sendDailyReport } from './notifier';
import {
  sendTelegramAlert,
  formatStartupAlert,
  formatErrorAlert,
} from './notificationManager';
import { extractV2Symbols, readWatchlist } from './watchlistIO';
import type {
  BarData,
  PendingSignal,
  PullbackTracker,
  SessionState,
  SignalTier,
  OrbState,
  Watchlist,
  WatchlistSymbol,
  EnteredSymbolEntry,
  WsMessage,
  WsBarMessage,
  WsSuccessMessage,
  WsErrorMessage,
  DiscordField,
  SpyTrend,
} from './types';
import { resolveSymbolTier } from './types';
import type { SessionDataEntry } from './riskManager';
import type { AlpacaBar, AlpacaOrder } from '@alpacahq/alpaca-trade-api';

const log = createLogger('SYSTEM');

// ---------------------------------------------------------------------------
// Global session state
// ---------------------------------------------------------------------------

let ws: WebSocket | null = null;
let reconnectAttempt = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// Set to true when circuit breaker or hard close triggers — blocks new entries
let tradingHalted = false;

// Symbols entered this session with portfolio tier (Core / Satellite)
const enteredByTier = new Map<string, SignalTier>();

// Watchlist tier and Satellite pre-market gap metadata
const symbolTier = new Map<string, SignalTier>();
const preMarketGaps = new Map<string, number>();
// Screener metadata per symbol — feeds the journal pre-trade context
const screenerDataMap = new Map<string, WatchlistSymbol>();
const orbState = new Map<string, OrbState>();

// Symbols currently subscribed on the WebSocket
let monitoredSymbols: string[] = [];

// V2 Play-Maker symbols that must stay monitored for the full session (no purge after 09:15)
const v2PersistentSymbols = new Set<string>();

// V3 pullback state machine and 1-min EMA9 inputs
const pullbackTrackers = new Map<string, PullbackTracker>();
const ema9ClosePrices = new Map<string, number[]>();
const EMA9_HISTORY_MAX = 50;
let isFlushInProgress = false;

// 5-min bars for signal generation (VWAP breakout, ORB, EOD session metrics)
const signalBars5m = new Map<string, BarData[]>();

// Rolling 1-min → 5-min aggregation (Alpaca WS bars channel is 1-minute)
const FIVE_MIN_MS = 5 * 60 * 1000;

interface FiveMinuteAggregator {
  periodStartMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: string;
}

const fiveMinAggregators = new Map<string, FiveMinuteAggregator>();

let liveBarsAnnounced = false;

// Session data for EOD sweep: cumulative VWAP, session high, last bar low
const sessionData = new Map<string, SessionDataEntry>();

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
  const now = getESTDate();
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
  const h = est.getHours();
  const m = est.getMinutes();
  return (
    h < config.session.marketOpenHour ||
    (h === config.session.marketOpenHour && m < config.session.blackoutEndMinute)
  );
}

// True only during the ORB window: market is open (>= 09:30) AND before 09:45.
// Prevents Satellite ORB signals from firing during pre-market bars.
function isOrbWindow(): boolean {
  return isRegularSessionStarted() && isBlackoutPeriod();
}

// ---------------------------------------------------------------------------
// Session state persistence (crash recovery)
// ---------------------------------------------------------------------------

const STATE_PATH = path.resolve(config.paths.sessionState);

function getTodayDateStr(): string {
  return new Date().toISOString().split('T')[0];
}

function hasEntered(symbol: string): boolean {
  return enteredByTier.has(symbol);
}

function getSymbolTier(symbol: string): SignalTier {
  return symbolTier.get(symbol) ?? 'core';
}

async function saveSessionState(): Promise<void> {
  const entries: EnteredSymbolEntry[] = [...enteredByTier.entries()].map(
    ([symbol, tier]) => ({ symbol, tier }),
  );
  const state: SessionState = {
    date: getTodayDateStr(),
    enteredSymbols: entries,
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
    const raw = await fs.readFile(STATE_PATH, 'utf8');
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
 *   1. Loads persisted state (enteredByTier) if date matches today
 *   2. Queries Alpaca for open positions → adds to enteredByTier
 *   3. Detects active trailing_stop orders → marks symbols as scaled-out in riskManager
 *      (prevents double scale-out post-crash)
 */
async function reconcileStateFromBroker(): Promise<void> {
  log.info('Reconciling state at startup...');

  const saved = await loadSessionState();
  if (saved) {
    for (const entry of saved.enteredSymbols ?? []) {
      if (typeof entry === 'string') {
        enteredByTier.set(entry, 'core');
      } else {
        enteredByTier.set(entry.symbol, entry.tier);
      }
    }
    log.info(`Persisted state loaded: ${enteredByTier.size} symbol(s) already entered today`);
  }

  const [positions, orders] = await Promise.all([
    trader.getOpenPositions(),
    trader.getOpenOrders().catch((): AlpacaOrder[] => []),
  ]);

  // Any open broker position = symbol already traded this session
  for (const pos of positions) {
    if (!enteredByTier.has(pos.symbol)) {
      enteredByTier.set(pos.symbol, 'core');
    }
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
    `${enteredByTier.size} session symbol(s), ` +
    `${alreadyScaledOut.length} trailing stop(s) detected`,
  );

  if (positions.length > 0) {
    const fields: DiscordField[] = positions.map(p => ({
      name: p.symbol,
      value: `qty:${p.qty} PnL:$${parseFloat(p.unrealized_pl).toFixed(2)}`,
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

function registerWatchlistSymbol(s: WatchlistSymbol): void {
  const tier = resolveSymbolTier(s);
  symbolTier.set(s.symbol, tier);
  screenerDataMap.set(s.symbol, s);
  if (tier === 'satellite' && s.preMarketGapPct !== undefined) {
    preMarketGaps.set(s.symbol, s.preMarketGapPct);
  }
}

async function loadWatchlistFromFile(): Promise<Watchlist | null> {
  const data = await readWatchlist();
  if (!data) return null;
  for (const s of data.symbols) {
    registerWatchlistSymbol(s);
  }
  return data;
}

async function loadWatchlist(): Promise<string[]> {
  symbolTier.clear();
  preMarketGaps.clear();

  let data = await loadWatchlistFromFile();

  if (!data || data.symbols.length === 0) {
    log.info('Watchlist missing or empty — running Core screener...');
    data = await runScreener();
    symbolTier.clear();
    preMarketGaps.clear();
    for (const s of data.symbols) {
      registerWatchlistSymbol(s);
    }
  }

  const v2Symbols = extractV2Symbols(data);
  for (const s of v2Symbols) {
    v2PersistentSymbols.add(s.symbol);
  }
  signalQueue.registerSatelliteWatchlist(v2Symbols.map(s => s.symbol));

  const v1Count = data.symbols.length - v2Symbols.length;
  log.info(
    `Watchlist loaded: ${data.symbols.length} symbol(s) ` +
    `(${v1Count} V1_CORE, ${v2Symbols.length} V2_PLAYMAKER) — generated ${data.generatedAt}`,
  );

  return data.symbols.map(s => s.symbol);
}

function applyV2WatchlistSymbols(v2Symbols: WatchlistSymbol[]): string[] {
  const newSymbols: string[] = [];

  for (const s of v2Symbols) {
    registerWatchlistSymbol(s);
    v2PersistentSymbols.add(s.symbol);
    if (!monitoredSymbols.includes(s.symbol)) {
      newSymbols.push(s.symbol);
    }
  }

  signalQueue.registerSatelliteWatchlist(v2Symbols.map(s => s.symbol));
  monitoredSymbols = [...new Set([...monitoredSymbols, ...v2PersistentSymbols])];
  return newSymbols;
}

function ensureV2SymbolsMonitored(): void {
  if (v2PersistentSymbols.size === 0) return;
  monitoredSymbols = [...new Set([...monitoredSymbols, ...v2PersistentSymbols])];
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

function pushEma9Close(symbol: string, close: number): void {
  const history = ema9ClosePrices.get(symbol) ?? [];
  history.push(close);
  if (history.length > EMA9_HISTORY_MAX) {
    history.shift();
  }
  ema9ClosePrices.set(symbol, history);
}

function computeEMA9(symbol: string): number | null {
  const prices = ema9ClosePrices.get(symbol);
  const period = config.indicators.ema9Period;
  if (!prices || prices.length < period) return null;

  const slice = prices.slice(-period);
  const k = 2 / (period + 1);
  let ema = slice[0];
  for (let i = 1; i < slice.length; i++) {
    ema = slice[i] * k + ema * (1 - k);
  }
  return ema;
}

function computeSMA20ForSymbol(symbol: string): number | null {
  const bars = signalBars5m.get(symbol);
  if (!bars || bars.length < 20) return null;
  const last20 = bars.slice(-20);
  return last20.reduce((sum, b) => sum + b.close, 0) / 20;
}

/**
 * Determines SPY 5-min trend at signal execution time.
 * Uses the in-memory 5-min bars if SPY is monitored; falls back to a REST call.
 */
async function fetchSpyTrend5m(): Promise<SpyTrend> {
  try {
    const spyBars = signalBars5m.get('SPY');
    if (spyBars && spyBars.length >= 2) {
      const last = spyBars[spyBars.length - 1];
      const prev = spyBars[spyBars.length - 2];
      if (last.close > prev.close) return 'bullish';
      if (last.close < prev.close) return 'bearish';
      return 'neutral';
    }

    const now = new Date();
    const start = new Date(now.getTime() - 30 * 60 * 1000);
    const bars: BarData[] = [];
    const iter = alpaca.getBarsV2('SPY', {
      start: start.toISOString(),
      end: now.toISOString(),
      timeframe: '5Min',
      feed: 'iex',
    });
    for await (const bar of iter) {
      bars.push(alpacaBarToBarData(bar));
    }
    if (bars.length < 2) return 'unknown';
    const last = bars[bars.length - 1];
    const prev = bars[bars.length - 2];
    if (last.close > prev.close) return 'bullish';
    if (last.close < prev.close) return 'bearish';
    return 'neutral';
  } catch {
    return 'unknown';
  }
}

function computeIntradayRvol(latestBar: BarData, bars: BarData[]): number | null {
  if (bars.length < 2) return null;
  const baseline = bars.slice(0, -1).slice(-config.entry.minBarsForVolumeAvg);
  const avgVolume = baseline.reduce((sum, b) => sum + b.volume, 0) / baseline.length;
  if (avgVolume <= 0) return null;
  return latestBar.volume / avgVolume;
}

function passesRvolForPullback(latestBar: BarData, bars: BarData[]): boolean {
  const rvol = computeIntradayRvol(latestBar, bars);
  return rvol !== null && rvol >= config.entry.minRvolForPullback;
}

function alpacaBarToBarData(bar: AlpacaBar): BarData {
  return {
    open: bar.OpenPrice,
    high: bar.HighPrice,
    low: bar.LowPrice,
    close: bar.ClosePrice,
    volume: bar.Volume,
    timestamp: bar.Timestamp,
  };
}

function getSessionDateStr(): string {
  const est = getESTDate();
  const y = est.getFullYear();
  const m = String(est.getMonth() + 1).padStart(2, '0');
  const d = String(est.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isRegularSessionStarted(): boolean {
  const est = getESTDate();
  const h = est.getHours();
  const m = est.getMinutes();
  if (h > config.session.marketOpenHour) return true;
  if (h === config.session.marketOpenHour && m >= config.session.marketOpenMinute) return true;
  return false;
}

/**
 * Volume conviction using all prior bars available (min 1).
 * Avoids a 30-minute dead zone after mid-session restarts when < 6 bars exist.
 */
function passesVolumeConviction(latestBar: BarData, bars: BarData[]): boolean {
  if (bars.length < 2) return false;

  const needed = config.entry.minBarsForVolumeAvg;
  const baseline = bars.slice(0, -1).slice(-needed);
  const avgVolume = baseline.reduce((sum, b) => sum + b.volume, 0) / baseline.length;
  if (avgVolume <= 0) return false;

  return latestBar.volume > avgVolume * config.entry.volumeBreakoutMultiplier;
}

function getFiveMinutePeriodStartMs(timestamp: string): number {
  return Math.floor(new Date(timestamp).getTime() / FIVE_MIN_MS) * FIVE_MIN_MS;
}

function aggregatorToBar(agg: FiveMinuteAggregator): BarData {
  return {
    open: agg.open,
    high: agg.high,
    low: agg.low,
    close: agg.close,
    volume: agg.volume,
    timestamp: agg.timestamp,
  };
}

/**
 * Ingests a 1-min WS bar. Returns a completed 5-min bar when the period rolls over.
 */
function ingestOneMinuteBar(symbol: string, bar: BarData): BarData | null {
  const periodStartMs = getFiveMinutePeriodStartMs(bar.timestamp);
  let agg = fiveMinAggregators.get(symbol);
  let completed: BarData | null = null;

  if (agg !== undefined && agg.periodStartMs !== periodStartMs) {
    completed = aggregatorToBar(agg);
    agg = undefined;
  }

  if (agg === undefined) {
    fiveMinAggregators.set(symbol, {
      periodStartMs,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      timestamp: new Date(periodStartMs).toISOString(),
    });
    return completed;
  }

  agg.high = Math.max(agg.high, bar.high);
  agg.low = Math.min(agg.low, bar.low);
  agg.close = bar.close;
  agg.volume += bar.volume;
  fiveMinAggregators.set(symbol, agg);
  return completed;
}

function upsertSignalBar(symbol: string, barData: BarData): BarData[] {
  let bars = signalBars5m.get(symbol);
  if (!bars) {
    bars = [];
    signalBars5m.set(symbol, bars);
  }

  const last = bars[bars.length - 1];
  if (last?.timestamp === barData.timestamp) {
    bars[bars.length - 1] = barData;
  } else {
    bars.push(barData);
  }

  const maxBars = 80;
  if (bars.length > maxBars) bars.splice(0, bars.length - maxBars);

  return bars;
}

function updateSessionDataFromBars(symbol: string, bars: BarData[]): void {
  const currentVwap = computeVwap(bars);
  if (currentVwap === null) return;

  const sessionHigh = bars.reduce((max, b) => Math.max(max, b.high), -Infinity);
  const lastBar = bars[bars.length - 1];
  sessionData.set(symbol, {
    vwap: currentVwap,
    high: sessionHigh,
    lastBarLow: lastBar.low,
  });
}

/** Seeds ORB range from opening 5-min window(s) after REST hydration. */
function seedOrbState(symbol: string, bars: BarData[]): void {
  if (getSymbolTier(symbol) !== 'satellite') return;

  const window = config.entry.orbWindowBars;
  if (bars.length < window) return;

  const opening = bars.slice(0, window);
  orbState.set(symbol, {
    high: Math.max(...opening.map(b => b.high)),
    low: Math.min(...opening.map(b => b.low)),
    barsCollected: window,
    triggered: false,
  });
}

async function hydrateIntradayBars(symbols: string[]): Promise<void> {
  if (!isRegularSessionStarted()) {
    log.info('Pre-open — intraday bar hydration skipped');
    return;
  }

  const sessionDate = getSessionDateStr();
  const end = new Date().toISOString();

  log.info(
    `Hydrating 5-min bars (${sessionDate} session) for ${symbols.length} symbols...`,
  );

  let symbolsWithBars = 0;
  let totalBars = 0;

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    try {
      const bars: BarData[] = [];
      const iter = alpaca.getBarsV2(symbol, {
        start: sessionDate,
        end,
        timeframe: '5Min',
        feed: 'iex',
        limit: 80,
      });

      for await (const bar of iter) {
        bars.push(alpacaBarToBarData(bar));
      }

      if (bars.length > 0) {
        signalBars5m.set(symbol, bars);
        totalBars += bars.length;
        symbolsWithBars++;
        seedOrbState(symbol, bars);
        updateSessionDataFromBars(symbol, bars);
      }
    } catch (err) {
      log.warn(`${symbol}: hydration failed — ${toErrorMessage(err)}`);
    }

    if (i + 1 < symbols.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  log.info(
    `Hydration done — ${symbolsWithBars}/${symbols.length} symbols, ` +
    `${totalBars} bar(s) loaded`,
  );

  for (const symbol of symbols) {
    const bars = signalBars5m.get(symbol);
    if (!bars || bars.length === 0) continue;

    const latest = bars[bars.length - 1];
    if (getSymbolTier(symbol) === 'satellite' && isBlackoutPeriod()) {
      evaluateOrbSignal(symbol, latest);
    }
    evaluateSignal(symbol, latest);
  }
}

// ---------------------------------------------------------------------------
// Signal evaluation (VWAP breakout + volume conviction filter)
// ---------------------------------------------------------------------------

/**
 * V3 VWAP breakout starts the pullback state machine (TRACKING_PULLBACK).
 * Execution is deferred until dynamic support + first tick up (evaluatePullbackState).
 */
function queuePendingSignal(signal: PendingSignal): void {
  signalQueue.enqueue(signal);
  schedulePendingSignalFlush();
}

function evaluateOrbSignal(symbol: string, latestBar: BarData): void {
  if (tradingHalted) return;
  if (hasEntered(symbol)) return;
  if (getSymbolTier(symbol) !== 'satellite') return;
  // Restrict ORB to the 09:30–09:45 window; pre-market bars are excluded.
  if (!isOrbWindow()) return;

  let state = orbState.get(symbol);
  if (!state) {
    state = { high: -Infinity, low: Infinity, barsCollected: 0, triggered: false };
    orbState.set(symbol, state);
  }
  if (state.triggered) return;

  const window = config.entry.orbWindowBars;
  const bars = signalBars5m.get(symbol) ?? [];

  if (state.barsCollected < window) {
    state.high = state.barsCollected === 0
      ? latestBar.high
      : Math.max(state.high, latestBar.high);
    state.low = state.barsCollected === 0
      ? latestBar.low
      : Math.min(state.low, latestBar.low);
    state.barsCollected++;
    orbState.set(symbol, state);
    if (state.barsCollected < window) return;
  }

  if (latestBar.close <= state.high) return;

  if (!passesVolumeConviction(latestBar, bars)) {
    log.info(`${symbol}: ORB breakout without volume conviction — ignored`);
    return;
  }

  const baselineBars = bars.slice(0, -1).slice(-config.entry.minBarsForVolumeAvg);
  const avgVolume = baselineBars.reduce((sum, b) => sum + b.volume, 0) / baselineBars.length;

  const orbDeviation = (latestBar.close - state.high) / state.high;
  const momentumScore = latestBar.volume * orbDeviation;
  const vwap = computeVwap(bars) ?? latestBar.close;

  state.triggered = true;
  orbState.set(symbol, state);

  log.info(
    `${symbol}: Satellite ORB signal — ` +
    `ORB high $${state.high.toFixed(2)} | close $${latestBar.close.toFixed(2)} | ` +
    `break ${(orbDeviation * 100).toFixed(2)}% | score ${Math.round(momentumScore).toLocaleString()} → queued`,
  );

  queuePendingSignal({
    symbol,
    tier: 'satellite',
    score: momentumScore,
    barData: latestBar,
    vwap,
    avgVolume,
  });
}

function evaluateSignal(symbol: string, latestBar: BarData): void {
  if (tradingHalted) return;
  if (hasEntered(symbol)) return;
  if (pullbackTrackers.has(symbol)) return;

  const tier = getSymbolTier(symbol);
  if (tier === 'satellite' && isBlackoutPeriod()) return;

  if (!config.entry.tradeDuringLunch && isLunchPeriod()) return;

  const bars = signalBars5m.get(symbol) ?? [];
  if (bars.length < 2) return;

  const vwap = computeVwap(bars);
  if (vwap === null) return;

  const currentPrice = latestBar.close;
  const prevBar = bars[bars.length - 2];

  const vwapBreakout = prevBar.close <= vwap && currentPrice > vwap;
  if (!vwapBreakout) return;

  if (currentPrice <= vwap) return;

  if (!passesRvolForPullback(latestBar, bars)) {
    const rvol = computeIntradayRvol(latestBar, bars);
    log.info(
      `${symbol}: VWAP breakout below RVOL threshold — ` +
      `rvol ${rvol === null ? 'N/A' : rvol.toFixed(2)}x (min ${config.entry.minRvolForPullback})`,
    );
    return;
  }

  const recentBars = bars.slice(0, -1).slice(-config.entry.minBarsForVolumeAvg);
  const avgVolume = recentBars.reduce((sum, b) => sum + b.volume, 0) / recentBars.length;

  const vwapDeviation = (currentPrice - vwap) / vwap;
  const momentumScore = latestBar.volume * vwapDeviation;

  pullbackTrackers.set(symbol, {
    state: 'TRACKING_PULLBACK',
    localHigh: latestBar.high,
    prevClose: currentPrice,
    vwapAtDetection: vwap,
    tier,
    score: momentumScore,
    avgVolume,
  });

  log.info(
    `${symbol}: ${tier} VWAP breakout — tracking pullback | ` +
    `price $${currentPrice.toFixed(2)} | VWAP $${vwap.toFixed(2)} | ` +
    `deviation ${(vwapDeviation * 100).toFixed(2)}% | ` +
    `score ${Math.round(momentumScore).toLocaleString()}`,
  );
}

/**
 * V3 pullback micro-structure on 1-min bars: support touch then first tick up → queue.
 */
function evaluatePullbackState(symbol: string, bar1m: BarData): void {
  if (tradingHalted || hasEntered(symbol)) {
    pullbackTrackers.delete(symbol);
    return;
  }

  const tracker = pullbackTrackers.get(symbol);
  if (!tracker) return;

  const session = sessionData.get(symbol);
  const vwap = session?.vwap ?? tracker.vwapAtDetection;
  const supportThreshold = bar1m.close * config.entry.pullbackSupportPct;

  if (tracker.state === 'TRACKING_PULLBACK') {
    if (bar1m.high > tracker.localHigh) {
      tracker.localHigh = bar1m.high;
    }

    const ema9 = computeEMA9(symbol);
    const distVwap = Math.abs(bar1m.close - vwap);
    const distEma = ema9 === null ? Infinity : Math.abs(bar1m.close - ema9);
    const distSupport = Math.min(distVwap, distEma);

    if (distSupport <= supportThreshold) {
      tracker.state = 'TRIGGERED';
      tracker.prevClose = bar1m.close;
      log.info(
        `${symbol}: pullback support touched — awaiting tick up | ` +
        `close $${bar1m.close.toFixed(2)} | VWAP $${vwap.toFixed(2)}` +
        (ema9 !== null ? ` | EMA9 $${ema9.toFixed(2)}` : ''),
      );
    }
    return;
  }

  if (tracker.state === 'TRIGGERED') {
    if (bar1m.close > tracker.prevClose) {
      pullbackTrackers.delete(symbol);
      log.info(
        `${symbol}: ${tracker.tier} pullback triggered — ` +
        `tick up $${tracker.prevClose.toFixed(2)} → $${bar1m.close.toFixed(2)} → queued`,
      );
      queuePendingSignal({
        symbol,
        tier: tracker.tier,
        score: tracker.score,
        barData: bar1m,
        vwap,
        avgVolume: tracker.avgVolume,
      });
      return;
    }
    tracker.prevClose = bar1m.close;
  }
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

function countOpenPositionsByTier(
  positions: Awaited<ReturnType<typeof trader.getOpenPositions>>,
): { core: number; satellite: number } {
  let core = 0;
  let satellite = 0;
  for (const pos of positions) {
    const tier = enteredByTier.get(pos.symbol) ?? 'core';
    if (tier === 'satellite') satellite++;
    else core++;
  }
  return { core, satellite };
}

async function executeSignalsForTier(
  signals: PendingSignal[],
  maxExecutions: number,
): Promise<string[]> {
  const executed: string[] = [];
  if (maxExecutions <= 0 || signals.length === 0) return executed;

  const ranked = [...signals].sort((a, b) => b.score - a.score);
  const toExecute = ranked.slice(0, maxExecutions);
  const rejected = ranked.slice(maxExecutions);

  rejected.forEach(s => {
    log.info(
      `  rejected  ${s.symbol.padEnd(6)} [${s.tier}] | score ${Math.round(s.score).toLocaleString()}`,
    );
  });

  for (const signal of toExecute) {
    const { symbol, barData, score, vwap, tier } = signal;

    log.info(
      `  executing ${symbol.padEnd(6)} [${tier}] | score ${Math.round(score).toLocaleString()} ` +
      `| deviation ${(((barData.close - vwap) / vwap) * 100).toFixed(2)}% ` +
      `| price $${barData.close.toFixed(2)}`,
    );

    try {
      const settledCash = await trader.getSettledCash();
      const allocation = await riskManager.getPortfolioAllocation(tier, enteredByTier);
      if (!allocation.canOpen) {
        log.warn(
          `${symbol}: ${tier} bucket capital exhausted ` +
          `($${allocation.deployed.toFixed(0)}/$${allocation.maxCapital.toFixed(0)}) — skipped`,
        );
        continue;
      }

      const { qty, stopLossPrice } = await riskManager.computePositionSize(
        symbol,
        barData.close,
        settledCash,
        tier,
        enteredByTier,
      );

      if (qty < 1) {
        log.warn(`${symbol}: position size 0 — ignored`);
        continue;
      }

      const order = await trader.placeBracketOrder(symbol, qty, vwap, barData.close, stopLossPrice, tier);
      enteredByTier.set(symbol, tier);

      // Prefer the actual submitted limit price over the stale bar close (can diverge by
      // up to marketableLimitVwapMultiplier × live-ask slippage).
      const submittedLimitPrice =
        order.limit_price !== undefined && order.limit_price !== ''
          ? parseFloat(order.limit_price)
          : barData.close;

      // Open journal record — capture all pre-trade and entry context
      const screenerData = screenerDataMap.get(symbol);
      const spyTrend = await fetchSpyTrend5m();
      journalManager.openTrade(symbol, {
        origin: screenerData?.origin ?? 'V1_CORE',
        alpha_vs_spy: screenerData?.relativeReturn ?? null,
        gap_percentage: screenerData?.gapUp ?? screenerData?.preMarketGapPct ?? null,
        relative_volume: screenerData?.relativeVolume ?? null,
        entry_price: submittedLimitPrice,
        qty,
        vwap_at_entry: vwap,
        ema9_at_entry: computeEMA9(symbol),
        sma20_at_entry: computeSMA20ForSymbol(symbol),
        spy_trend_5m: spyTrend,
      });

      executed.push(symbol);
      await saveSessionState();
    } catch (err) {
      log.error(`${symbol}: order failed — ${toErrorMessage(err)}`);
      void sendTelegramAlert(formatErrorAlert(`${symbol}: ${toErrorMessage(err)}`));
    }
  }

  return executed;
}

/**
 * V3 dual-bucket flush: time-decay slots, Core-first priority, serialized execution.
 * During opening blackout, only Satellite (ORB) signals may execute; Core is deferred.
 */
async function flushPendingSignals(): Promise<void> {
  signalFlushTimer = null;

  if (signalQueue.size() === 0) return;
  if (isFlushInProgress) return;

  isFlushInProgress = true;
  try {
    if (tradingHalted || riskManager.isCircuitBreakerTriggered()) {
      log.info(`Flush cancelled: trading halted (${signalQueue.size()} signal(s) dropped)`);
      signalQueue.clear();
      return;
    }

    let currentPositions: Awaited<ReturnType<typeof trader.getOpenPositions>>;
    try {
      currentPositions = await trader.getOpenPositions();
    } catch (err) {
      log.error(`Flush impossible: API error on positions — ${toErrorMessage(err)}`);
      signalQueue.clear();
      return;
    }

    const estNow = getESTDate();
    const openCounts = countOpenPositionsByTier(currentPositions);
    const slotLimits = getTimedecaySlotLimits(estNow, openCounts.core);
    const coreSlotsAvailable =
      slotLimits.coreMaxPositions - openCounts.core;
    const satelliteSlotsAvailable =
      slotLimits.satelliteMaxPositions - openCounts.satellite;

    const filterEntered = (signals: PendingSignal[]) =>
      signals.filter(s => !hasEntered(s.symbol));

    const satelliteCandidates = filterEntered(signalQueue.getSatelliteSignals());
    const coreCandidates = filterEntered(signalQueue.getCoreSignals());

    const blackout = isBlackoutPeriod();
    if (blackout && coreCandidates.length > 0 && satelliteCandidates.length === 0) {
      log.info(`Blackout active — ${coreCandidates.length} Core signal(s) deferred`);
      schedulePendingSignalFlush();
      return;
    }

    const executedSymbols: string[] = [];

    if (!blackout && coreCandidates.length > 0) {
      log.info(
        `Flush Core — ${coreCandidates.length} candidate(s), ` +
        `slots ${coreSlotsAvailable}/${slotLimits.coreMaxPositions} ` +
        `(time-decay @ ${estNow.getHours()}:${String(estNow.getMinutes()).padStart(2, '0')} EST)`,
      );
      const coreExecuted = await executeSignalsForTier(
        coreCandidates,
        coreSlotsAvailable,
      );
      executedSymbols.push(...coreExecuted);
    } else if (blackout && coreCandidates.length > 0) {
      log.info(`Blackout active — ${coreCandidates.length} Core signal(s) kept pending`);
      schedulePendingSignalFlush();
    }

    if (satelliteCandidates.length > 0) {
      if (!isRegularSessionStarted()) {
        // Market not yet open — keep Satellite signals pending until 09:30.
        log.info(`Pre-market — ${satelliteCandidates.length} Satellite signal(s) held until 09:30`);
        schedulePendingSignalFlush();
      } else {
        log.info(
          `Flush Satellite — ${satelliteCandidates.length} candidate(s), ` +
          `slots ${satelliteSlotsAvailable}/${slotLimits.satelliteMaxPositions}`,
        );
        const satExecuted = await executeSignalsForTier(
          satelliteCandidates,
          satelliteSlotsAvailable,
        );
        executedSymbols.push(...satExecuted);
      }
    }

    signalQueue.remove(executedSymbols);

    if (!blackout) {
      signalQueue.clear();
    }
  } finally {
    isFlushInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// 1-minute WS bar handler (signals aggregated to 5-min; positions on 1-min)
// ---------------------------------------------------------------------------

async function handleOneMinuteBarEvent(bar: WsBarMessage): Promise<void> {
  const symbol = bar.S;
  const barData: BarData = {
    open: bar.o,
    high: bar.h,
    low: bar.l,
    close: bar.c,
    volume: bar.v,
    timestamp: bar.t,
  };

  if (!liveBarsAnnounced) {
    liveBarsAnnounced = true;
    log.info(`Live 1-min bars flowing — first tick: ${symbol} @ $${barData.close.toFixed(2)}`);
  }

  pushEma9Close(symbol, barData.close);
  evaluatePullbackState(symbol, barData);

  // UT1m take-profit monitoring: every 1-min close triggers the tier-specific
  // scale-out check (5% Core / 7% Satellite) for confirmed open positions.
  if (hasEntered(symbol)) {
    // Track excursions for MFE/MAE before any exit check
    journalManager.updateExcursions(symbol, barData.close);

    try {
      await riskManager.handlePositionUpdate(
        symbol,
        barData.close,
        enteredByTier.get(symbol) ?? 'core',
      );
    } catch (err) {
      log.error(`${symbol}: position update error — ${toErrorMessage(err)}`);
    }

    // Detect broker-side stop fills (stop-loss or trailing stop)
    if (riskManager.wasExternallyExited(symbol)) {
      const exitReason = riskManager.wasScaledOut(symbol)
        ? 'trailing-stop' as const
        : 'stop-loss-initial' as const;
      journalManager.closeTrade(symbol, exitReason, barData.close);
    }
  }

  // Circuit breaker equity check — throttled to 1 REST call/minute max
  if (!tradingHalted) {
    const now = Date.now();
    if (now - lastEquityCheckMs >= EQUITY_CHECK_INTERVAL_MS) {
      lastEquityCheckMs = now;
      try {
        const equity = await trader.getAccountEquity();
        const triggered = await riskManager.checkCircuitBreaker(equity);
        if (triggered) {
          tradingHalted = true;
          const pnlPct = (((equity - sessionStartEquity) / sessionStartEquity) * 100).toFixed(2);
          log.info(`Trading halted — daily target +${pnlPct}% reached`);
          alertCritical(
            'Daily circuit breaker triggered',
            `Target +${config.risk.dailyProfitTargetPct * 100}% reached. All positions liquidated. No new trades today.`,
            [
              { name: 'PnL', value: `+${pnlPct}%`, inline: true },
              { name: 'Equity', value: `$${equity.toFixed(2)}`, inline: true },
            ],
          ).catch(() => { });
          void sendTelegramAlert(
            formatErrorAlert(
              `Circuit Breaker déclenché — PnL +${pnlPct}% atteint. Trading suspendu.`,
            ),
          );
          return;
        }
      } catch (err) {
        log.error(`Circuit breaker check error: ${toErrorMessage(err)}`);
      }
    }
  }

  // Aggregate 1-min → 5-min for signal path (VWAP breakout, ORB, EOD metrics).
  const completed5m = ingestOneMinuteBar(symbol, barData);
  if (!completed5m) return;

  const bars5m = upsertSignalBar(symbol, completed5m);
  updateSessionDataFromBars(symbol, bars5m);

  const tier = getSymbolTier(symbol);
  if (tier === 'satellite' && isOrbWindow()) {
    evaluateOrbSignal(symbol, completed5m);
  }
  evaluateSignal(symbol, completed5m);
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
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : Buffer.from(raw as ArrayBuffer).toString('utf8');
    const parsed = JSON.parse(text) as unknown;
    messages = Array.isArray(parsed) ? (parsed as WsMessage[]) : [parsed as WsMessage];
  } catch {
    return;
  }

  for (const msg of messages) {
    if (isWsSuccessMessage(msg) && msg.msg === 'authenticated') {
      log.info(`WebSocket authenticated — subscribing to ${symbols.length} symbols`);
      ws?.send(buildSubscribeMessage(symbols));
    }

    if (isWsBarMessage(msg)) {
      await handleOneMinuteBarEvent(msg);
    }

    if (isWsErrorMessage(msg)) {
      log.warn(`WebSocket error: code ${msg.code} — ${msg.msg}`);
      void sendTelegramAlert(formatErrorAlert(`WebSocket: code ${msg.code} — ${msg.msg}`));
    }
  }
}

function connectWebSocket(symbols: string[]): void {
  const authMessage = JSON.stringify({
    action: 'auth',
    key: config.alpaca.keyId,
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
    void sendTelegramAlert(formatErrorAlert(`WebSocket déconnecté (code ${code}) — reconnexion...`));
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
    ).catch(() => { });
    void sendTelegramAlert(
      formatErrorAlert(
        `WebSocket irrecoverable — ${MAX_RECONNECT_ATTEMPTS} tentatives épuisées. Intervention manuelle requise.`,
      ),
    );
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

// 16:05 EST: market fully closed → send EOD report + V5 post-mortem (state untouched)
function scheduleEodReport(): void {
  const ms = msUntilESTTime(config.session.eodReportHour, config.session.eodReportMinute);
  log.info(`EOD report scheduled in ${Math.round(ms / 1000 / 60)} minutes`);
  setTimeout((): void => {
    log.info('Sending EOD report...');
    trader.getAccountEquity()
      .then(async (endEquity) => {
        await sendDailyReport({
          startEquity: sessionStartEquity,
          endEquity,
          tradesEntered: enteredByTier.size,
          circuitBreakerFired: riskManager.isCircuitBreakerTriggered(),
          symbols: [...enteredByTier.keys()],
        });
      })
      .catch(() => { });

    // V5 post-mortem analysis
    log.info('Running V5 post-mortem analysis...');
    runPostMortem().catch((err: unknown) => {
      log.error(`Post-mortem analysis failed: ${toErrorMessage(err)}`);
    });

    scheduleEodReport();
  }, ms);
}

// 20:00 EST: full session state reset + screener for D+1 + WebSocket refresh
function scheduleDailyReset(): void {
  const ms = msUntilESTTime(config.session.screenerHour, config.session.screenerMinute);
  log.info(`Daily reset + screener scheduled in ${Math.round(ms / 1000 / 60)} minutes`);
  setTimeout((): void => {
    log.info('Daily reset 20:00 — purging session state for D+1...');

    fs.unlink(path.resolve(config.paths.sessionState)).catch(() => { });

    tradingHalted = false;
    lastEquityCheckMs = 0;
    enteredByTier.clear();
    symbolTier.clear();
    preMarketGaps.clear();
    screenerDataMap.clear();
    orbState.clear();
    v2PersistentSymbols.clear();
    pullbackTrackers.clear();
    ema9ClosePrices.clear();
    journalManager.reset();
    isFlushInProgress = false;
    monitoredSymbols = [];
    signalQueue.clear();
    if (signalFlushTimer) {
      clearTimeout(signalFlushTimer);
      signalFlushTimer = null;
    }
    signalBars5m.clear();
    fiveMinAggregators.clear();
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
      .then(async watchlist => {
        symbolTier.clear();
        preMarketGaps.clear();
        for (const s of watchlist.symbols) {
          registerWatchlistSymbol(s);
        }
        const newSymbols = watchlist.symbols.map(s => s.symbol);
        monitoredSymbols = newSymbols;
        ensureV2SymbolsMonitored();
        log.info(`Core screener done — ${newSymbols.length} symbol(s) ready for next session`);
        if (newSymbols.length > 0) {
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

// 09:30 EST: market open session alert
function scheduleMarketOpenAlert(): void {
  const ms = msUntilESTTime(config.session.marketOpenHour, config.session.marketOpenMinute);
  log.info(`Market open alert 09:30 scheduled in ${Math.round(ms / 1000 / 60)} minutes`);
  setTimeout((): void => {
    const openCore = [...enteredByTier.values()].filter(t => t === 'core').length;
    const slots = getTimedecaySlotLimits(getESTDate(), openCore);
    void sendTelegramAlert(
      formatStartupAlert(sessionStartEquity, slots.coreMaxPositions, slots.satelliteMaxPositions),
    );
    scheduleMarketOpenAlert();
  }, ms);
}

// 09:15 EST: pre-market broker reconciliation (post-crash / post-weekend safety net)
function schedulePreMarketReconciliation(): void {
  const ms = msUntilESTTime(config.session.preMarketHour, config.session.preMarketMinute);
  log.info(`Pre-market reconciliation scheduled in ${Math.round(ms / 1000 / 60)} minutes`);
  setTimeout((): void => {
    log.info('Pre-market 09:15 — reconciliation + Satellite screener...');
    reconcileStateFromBroker()
      .then(() => runPremarketScreener())
      .then(watchlist => {
        const v2Symbols = extractV2Symbols(watchlist);
        const newSymbols = applyV2WatchlistSymbols(v2Symbols);
        log.info(
          `Play-Maker V2 done — ${v2Symbols.length} symbol(s), ` +
          `${newSymbols.length} new WebSocket subscription(s)`,
        );
        if (ws && newSymbols.length > 0) {
          ws.send(buildSubscribeMessage(newSymbols));
        }
      })
      .catch((err: unknown) => {
        log.error(`Pre-market routine error: ${toErrorMessage(err)}`);
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
  monitoredSymbols = symbols;

  // Always arm all crons — they must fire even on empty-watchlist days
  scheduleEodSweep();
  scheduleHardClose();
  scheduleEodReport();
  scheduleDailyReset();
  schedulePreMarketReconciliation();
  scheduleMarketOpenAlert();

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

  await hydrateIntradayBars(symbols);

  connectWebSocket(symbols);

  const coreCount = [...symbolTier.values()].filter(t => t === 'core').length;
  const satCount = [...symbolTier.values()].filter(t => t === 'satellite').length;
  const openCore = [...enteredByTier.values()].filter(t => t === 'core').length;
  const slots = getTimedecaySlotLimits(getESTDate(), openCore);
  log.info(
    `Bot active — ${symbols.length} symbols (${coreCount} Core, ${satCount} Satellite) | ` +
    `slots ${slots.coreMaxPositions} Core / ${slots.satelliteMaxPositions} Satellite`,
  );
  await sendTelegramAlert(
    formatStartupAlert(sessionStartEquity, slots.coreMaxPositions, slots.satelliteMaxPositions),
  );
  await alertInfo(
    'Bot started',
    `Monitoring ${symbols.length} symbols (${coreCount} Core, ${satCount} Satellite) | ` +
    `Equity: $${sessionStartEquity.toFixed(2)}`,
  ).catch(() => { });

}

// ---------------------------------------------------------------------------
// Graceful shutdown — saves state before PM2 kills the process
// ---------------------------------------------------------------------------

async function gracefulShutdown(signal: string): Promise<void> {
  log.warn(`Signal ${signal} received — saving state and shutting down`);
  await saveSessionState().catch(() => { });
  process.exit(0);
}

process.on('SIGTERM', () => { gracefulShutdown('SIGTERM').catch(() => { }); });
process.on('SIGINT', () => { gracefulShutdown('SIGINT').catch(() => { }); });

main().catch(async (err: unknown) => {
  const message = toErrorMessage(err);
  log.error(`Fatal error at startup: ${message}`);
  await sendTelegramAlert(formatErrorAlert(`Fatal startup: ${message}`));
  await alertCritical('Fatal startup error', message).catch(() => { });
  process.exit(1);
});
