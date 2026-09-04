import fs from 'fs/promises';
import path from 'path';
import WebSocket from 'ws';
import { RSI } from 'technicalindicators';
import config from './config';
import { runScreener } from './screener';
import { runPremarketScreener } from './premarket_screener';
import * as signalQueue from './signalQueue';
import * as trader from './trader';
import * as riskManager from './riskManager';
import * as positionManager from './positionManager';
import * as journalManager from './journalManager';
import * as feedbackEngine from './feedbackEngine';
import * as shadowJournal from './shadowJournal';
import { runPostMortem } from './analyzer';
import { isTradingDay, queryRequiredWatchlistTradingDay } from './marketCalendar';
import alpaca from './alpacaClient';
import { createLogger } from './logger';
import { isEtfLikeProduct } from './screenerMath';
import {
  clampQueryEnd,
  getESTDate,
  isNonRetryableOrderError,
  isRateLimitError,
  isSipStreamDenied,
  isSymbolLimitExceeded,
  nyWallTimeToUtc,
  toESTDate,
  toErrorMessage,
} from './utils';
import {
  computeSpreadPct,
  describeOpeningDriveDecision,
  evaluateOpeningDrive,
  isOpeningDriveFunnelRejection,
  SCANNER_HOLD_GATES,
  type OpeningDriveContext,
  type OpeningDriveOptions,
} from './openingDrive';
import {
  allocateStreamChannels,
  capMonitoredUniverse,
  describeStreamPlan,
  uniqueSymbols,
  type StreamChannelPlan,
} from './streamSubscriptions';
import { alertCritical, alertInfo, sendDailyReport } from './notifier';
import {
  sendTelegramAlert,
  formatStartupAlert,
  formatErrorAlert,
} from './notificationManager';
import { extractV2Symbols, isV2Symbol, readWatchlist, writePremarketWatchlist } from './watchlistIO';
import { isWatchlistCurrent } from './watchlistFreshness';
import { selectOpeningRangeBar } from './openingRange';
import { buildEligiblePool, readEligiblePool } from './eligiblePool';
import { moversToWatchlist, scanSessionExtension, isScannerClockWindow } from './openingScanner';
import {
  addBarToVwap,
  computeVwap,
  emptyVwapAccumulator,
  removeBarFromVwap,
  vwapFromAccumulator,
} from './sessionVwap';
import {
  computeFibLevels,
  deriveFibLevelsFromBars,
  evaluateFibProximity,
  formatFibLog,
} from './fibonacci';
import {
  hasImpulseExtension,
  hasVolumeDryUp,
  isGreenBarWithRvol,
  isNearVwap,
  isVwapLagger,
  isVwapPullbackEntryWindow,
  liveSetupGates,
  minutesSinceMidnight,
  shouldHardBanSpyBearish,
  volumesFromBars,
  VWAP_HYPER_GROWTH_GATES,
  type EntryWindowBounds,
} from './vwapSetup';
import { resolveRiskDollarsAtEntry } from './expectancy';
import { remainingPositionSlots, ticketEfficiencyFactor } from './riskSizing';
import { createMarketDataBus } from './marketDataBus';
import { createHeartbeatWriter } from './heartbeat';
import { startPolicyMonitor, stopPolicyMonitor } from './policyMonitor';
import { assessQuoteForWall } from './orderBook';
import {
  computeTapeDelta,
  minuteEpoch,
  signPrint,
  type TapeBucket,
} from './tapeDelta';
import {
  getEffectiveRiskPerTradePct,
  runMorningRegimeAssessment,
} from './regimeModel';
import type {
  BarData,
  HeartbeatSnapshot,
  PendingSignal,
  PullbackTracker,
  SessionPhase,
  SessionState,
  SetupKind,
  OrbState,
  WatchlistSymbol,
  Watchlist,
  EnteredSymbolEntry,
  WsMessage,
  WsBarMessage,
  WsQuoteMessage,
  WsTradeMessage,
  WsSuccessMessage,
  WsErrorMessage,
  DiscordField,
  SpyTrend,
  ImbalanceSignal,
  WsState,
  MarketDataEvent,
} from './types';
import { formatSetupTag, parseEnteredSetup } from './types';
import type { SessionDataEntry } from './riskManager';
import type { AlpacaBar, AlpacaOrder } from '@alpacahq/alpaca-trade-api';

const log = createLogger('SYSTEM');
const traderLog = createLogger('TRADER');
const l2Log = createLogger('L2');
const odLog = createLogger('OPENING_DRIVE');

/** WS producer → strategy consumer (decoupled ingest). */
const marketDataBus = createMarketDataBus({
  maxQueueSize: config.bus.maxQueueSize,
  dropPolicy: config.bus.dropPolicy,
});

// ---------------------------------------------------------------------------
// Global session state
// ---------------------------------------------------------------------------

let ws: WebSocket | null = null;
let reconnectAttempt = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
let wsEnabled = false;

// Set to true when circuit breaker or hard close triggers — blocks new entries
let tradingHalted = false;

// Symbols entered this session, keyed by the setup that filled
const enteredBySetup = new Map<string, SetupKind>();

// Play-Maker (V2) universe — ORB + V3 1m pullback. V1 names use VWAP_PULLBACK V7.
const orbUniverse = new Set<string>();
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

// Level 2 / quote wall arming (Core VWAP complementary trigger)
const l2WallSignals = new Map<string, ImbalanceSignal>();
const l2QuotesSeen = new Set<string>();
const lastNbbo = new Map<string, { bid: number; ask: number; mid: number }>();
const L2_LOG_MIN_INTERVAL_MS = 15_000;
const lastL2LogAt = new Map<string, number>();
const lastLoggedL2Wall = new Map<string, boolean>();
const tapeMinutes = new Map<string, Map<number, TapeBucket>>();
const lastTradePrice = new Map<string, number>();

// Regular-session open per symbol — the Opening Drive extension reference.
// Captured from the first 1-min bar timestamped at or after 09:30 EST, never
// from a pre-market bar, and never from wall-clock time (hydration replays bars).
const sessionOpenPrice = new Map<string, number>();
// First RTH 1-min bar — the ORB 1-min range. Later bars may break its high.
const openingRangeBar = new Map<string, BarData>();
// Symbols already evaluated-and-armed by the Opening Drive path this session.
const openingDriveTriggered = new Set<string>();
const openingDriveRejectLogged = new Set<string>();
// Symbols whose audited rejection was already recorded. Tracked apart from the
// armed set: a name can be capped at 09:51 and legitimately arm at 09:54 once
// VWAP catches up, and both observations matter — but only the first cap does.
const openingDriveAuditLogged = new Set<string>();
// Live scanner ranking. Empty until the first 09:31 tick — no warmup substitute fills.
const scannerMoverSymbols = new Set<string>();

// Rolling 1-min bar history for RSI, VMA_10 and Satellite volume confirmation
const oneMinBarHistory = new Map<string, BarData[]>();
const ONE_MIN_HISTORY_MAX = 30;
// Session VWAP from seeded 1-min bars (04:00→now). History is truncated; this is not.
const sessionVwapAccum = new Map<string, { tpv: number; volume: number }>();
// Max 1-min high since 09:30. History is truncated to 30 bars; this peak is not.
const sessionImpulseHigh = new Map<string, number>();
const atrAtEntry = new Map<string, number>();
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

let activeStreamFeed: 'iex' | 'sip' = config.alpaca.streamFeed;
let sipStreamFallbackUsed = false;
/** After a 405, the current socket retries bars-only instead of looping 3×N. */
let streamBarsOnly = false;
let openingScannerTimer: ReturnType<typeof setTimeout> | null = null;

function streamUrl(): string {
  return `wss://stream.data.alpaca.markets/v2/${activeStreamFeed}`;
}

// ---------------------------------------------------------------------------
// Liveness telemetry — produced for the standalone watchdog, never read back
// ---------------------------------------------------------------------------

const botStartedAt = new Date().toISOString();
let wsState: WsState = 'disabled';
let lastBarAt: string | null = null;
let watchlistGeneratedAt: string | null = null;
let watchlistTradingDay: string | null = null;
let requiredWatchlistTradingDay: string | null = null;
let tradingDayFlag = false;
let currentSessionPhase: SessionPhase | null = null;
let sessionPhaseSince = botStartedAt;

// Broker-sourced position count. The in-process `enteredBySetup` map is cleared on
// bar events, which stop flowing after the close — precisely when the overnight
// exposure check matters — so the count is refreshed independently.
let openPositionsCount = 0;
let openPositionsCheckedAt: string | null = null;
const POSITION_REFRESH_INTERVAL_MS = 60_000;

function resolveSessionPhase(): SessionPhase {
  if (!tradingDayFlag) return 'non_trading_day';
  const mins = minutesSinceMidnight(getESTDate());
  const open = config.session.marketOpenHour * 60 + config.session.marketOpenMinute;
  const close = config.session.hardCloseHour * 60 + config.session.hardCloseMinute;
  if (mins < open) return 'pre_open';
  if (mins < close) return 'session';
  return 'post_close';
}

function buildHeartbeatSnapshot(): HeartbeatSnapshot {
  const writtenAt = new Date().toISOString();
  const sessionPhase = resolveSessionPhase();

  if (sessionPhase !== currentSessionPhase) {
    currentSessionPhase = sessionPhase;
    sessionPhaseSince = writtenAt;
  }

  return {
    writtenAt,
    startedAt: botStartedAt,
    pid: process.pid,
    sessionPhase,
    sessionPhaseSince,
    tradingDay: tradingDayFlag,
    tradingHalted,
    wsState,
    lastBarAt,
    monitoredSymbols: monitoredSymbols.length,
    openPositions: openPositionsCount,
    openPositionsCheckedAt,
    watchlistGeneratedAt,
    watchlistTradingDay,
    requiredWatchlistTradingDay,
  };
}

async function refreshRequiredWatchlistTradingDay(): Promise<void> {
  requiredWatchlistTradingDay = await queryRequiredWatchlistTradingDay();
}

const heartbeatWriter = createHeartbeatWriter(
  config.paths.heartbeat,
  config.health.heartbeatIntervalMs,
  buildHeartbeatSnapshot,
);

async function refreshOpenPositionsCount(): Promise<void> {
  try {
    const positions = await trader.getOpenPositions();
    openPositionsCount = positions.length;
    openPositionsCheckedAt = new Date().toISOString();
  } catch (err) {
    // Keep the last known count and let it age out — the watchdog ignores a
    // stale count rather than alerting on it.
    log.warn(`Open position refresh failed: ${toErrorMessage(err)}`);
  }
}

function startPositionRefreshLoop(): void {
  void refreshOpenPositionsCount();
  const timer = setInterval(() => { void refreshOpenPositionsCount(); }, POSITION_REFRESH_INTERVAL_MS);
  timer.unref();
}

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

function isBlackoutPeriod(): boolean {
  const est = getESTDate();
  const h = est.getHours();
  const m = est.getMinutes();
  return (
    h < config.session.marketOpenHour ||
    (h === config.session.marketOpenHour && m < config.session.blackoutEndMinute)
  );
}

function coreEntryWindowBounds(): EntryWindowBounds {
  return {
    startHour: config.entry.entryWindowStartHour,
    startMinute: config.entry.entryWindowStartMinute,
    endHour: config.entry.entryWindowEndHour,
    endMinute: config.entry.entryWindowEndMinute,
  };
}

function isCoreEntryWindowOpen(): boolean {
  return isVwapPullbackEntryWindow(getESTDate(), coreEntryWindowBounds());
}

function isBeforeCoreEntryWindow(): boolean {
  const bounds = coreEntryWindowBounds();
  const start = bounds.startHour * 60 + bounds.startMinute;
  return minutesSinceMidnight(getESTDate()) < start;
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
  return enteredBySetup.has(symbol);
}

function isOrbUniverse(symbol: string): boolean {
  return orbUniverse.has(symbol);
}

async function saveSessionState(): Promise<void> {
  const entries: EnteredSymbolEntry[] = [...enteredBySetup.entries()].map(
    ([symbol, setup]) => ({ symbol, setup }),
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
 *   1. Loads persisted state (enteredBySetup) if date matches today
 *   2. Queries Alpaca for open positions → adds to enteredBySetup
 *   3. Detects active trailing_stop orders → marks symbols as scaled-out in riskManager
 *      (prevents double scale-out post-crash)
 */
async function reconcileStateFromBroker(): Promise<void> {
  log.info('Reconciling state at startup...');

  const saved = await loadSessionState();
  if (saved) {
    for (const entry of saved.enteredSymbols ?? []) {
      if (typeof entry === 'string') {
        enteredBySetup.set(entry, 'VWAP_PULLBACK');
      } else {
        enteredBySetup.set(entry.symbol, parseEnteredSetup(entry));
      }
    }
    log.info(`Persisted state loaded: ${enteredBySetup.size} symbol(s) already entered today`);
  }

  const [positions, orders] = await Promise.all([
    trader.getOpenPositions(),
    trader.getOpenOrders().catch((): AlpacaOrder[] => []),
  ]);

  // Any open broker position = symbol already traded this session
  for (const pos of positions) {
    if (!enteredBySetup.has(pos.symbol)) {
      enteredBySetup.set(pos.symbol, 'VWAP_PULLBACK');
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
    `${enteredBySetup.size} session symbol(s), ` +
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
  screenerDataMap.set(s.symbol, s);
  if (isV2Symbol(s)) {
    orbUniverse.add(s.symbol);
    if (s.preMarketGapPct !== undefined) {
      preMarketGaps.set(s.symbol, s.preMarketGapPct);
    }
  }
}

async function loadWatchlist(skipScreener = false): Promise<string[]> {
  orbUniverse.clear();
  preMarketGaps.clear();

  await refreshRequiredWatchlistTradingDay();

  let data = await readWatchlist();
  watchlistGeneratedAt = data?.generatedAt ?? null;
  watchlistTradingDay = data?.tradingDay ?? null;

  if (!isWatchlistCurrent(data, requiredWatchlistTradingDay)) {
    if (skipScreener) {
      log.warn(
        `Watchlist not current (have ${watchlistTradingDay ?? 'none'}, ` +
        `need ${requiredWatchlistTradingDay ?? 'unknown'}) — screener skipped (market closed)`,
      );
      return [];
    }

    if (!config.screener.eveningScreenerEnabled) {
      const nowMins = minutesSinceMidnight(getESTDate());
      const preMarketMins =
        config.session.preMarketHour * 60 + config.session.preMarketMinute;
      if (!skipScreener && nowMins >= preMarketMins) {
        log.info(
          `Watchlist stale — evening screener off; running Hyper-Growth pre-market scan...`,
        );
        try {
          data = await runPremarketScreener();
          watchlistGeneratedAt = data.generatedAt;
          watchlistTradingDay = data.tradingDay ?? null;
        } catch (err: unknown) {
          const message = toErrorMessage(err);
          log.error(`Premarket rescreen failed: ${message}`);
          void sendTelegramAlert(formatErrorAlert(`Premarket rescreen failed: ${message}`));
          return [];
        }
      } else {
        log.warn(
          `Watchlist not current (have ${watchlistTradingDay ?? 'none'}, ` +
          `need ${requiredWatchlistTradingDay ?? 'unknown'}) — ` +
          `evening screener disabled; waiting for 09:15 pre-market scan`,
        );
        watchlistGeneratedAt = null;
        watchlistTradingDay = null;
        return [];
      }
    } else {
    log.info(
      `Watchlist stale or missing (have ${watchlistTradingDay ?? 'none'}, ` +
      `need ${requiredWatchlistTradingDay ?? 'unknown'}) — running Core screener...`,
    );
    try {
      data = await runScreener(requiredWatchlistTradingDay ?? undefined);
      watchlistGeneratedAt = data.generatedAt;
      watchlistTradingDay = data.tradingDay ?? null;
    } catch (err: unknown) {
      const message = toErrorMessage(err);
      log.error(`Watchlist rescreen failed: ${message}`);
      void sendTelegramAlert(formatErrorAlert(`Watchlist rescreen failed: ${message}`));
      return [];
    }

    if (!isWatchlistCurrent(data, requiredWatchlistTradingDay)) {
      log.error(
        `Screener wrote a watchlist that is still not current ` +
        `(have ${data.tradingDay ?? 'none'}, need ${requiredWatchlistTradingDay ?? 'unknown'})`,
      );
      void sendTelegramAlert(
        formatErrorAlert('Watchlist still stale after screener — failing closed'),
      );
      return [];
    }
    }
  }

  if (data === null || data.symbols.length === 0) {
    log.warn('Watchlist empty after load');
    return [];
  }

  if (
    !config.screener.eveningScreenerEnabled &&
    data.symbols.some(s => !isV2Symbol(s))
  ) {
    log.warn(
      'On-disk watchlist still contains Core names — ignored (Hyper-Growth is V2-only)',
    );
    watchlistGeneratedAt = null;
    watchlistTradingDay = null;
    return [];
  }

  for (const s of data.symbols) {
    registerWatchlistSymbol(s);
  }

  const v2Symbols = extractV2Symbols(data);
  for (const s of v2Symbols) {
    v2PersistentSymbols.add(s.symbol);
  }

  watchlistGeneratedAt = data.generatedAt;
  watchlistTradingDay = data.tradingDay ?? null;

  const v1Count = data.symbols.length - v2Symbols.length;
  log.info(
    `Watchlist loaded: ${data.symbols.length} symbol(s) ` +
    `(${v1Count} V1_CORE, ${v2Symbols.length} V2_PLAYMAKER) ` +
    `— tradingDay ${data.tradingDay ?? 'unknown'} generated ${data.generatedAt}`,
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

  monitoredSymbols = [...new Set([...monitoredSymbols, ...v2PersistentSymbols])];
  return newSymbols;
}

/** Drop leftover Core names and rebuild the live universe from a V2-only list. */
function replaceMonitoredUniverse(watchlist: Watchlist): string[] {
  orbUniverse.clear();
  preMarketGaps.clear();
  screenerDataMap.clear();
  v2PersistentSymbols.clear();
  openingRangeBar.clear();
  sessionOpenPrice.clear();
  openingDriveTriggered.clear();
  openingDriveAuditLogged.clear();
  openingDriveRejectLogged.clear();
  lastNbbo.clear();
  lastL2LogAt.clear();
  lastLoggedL2Wall.clear();
  tapeMinutes.clear();
  lastTradePrice.clear();
  scannerMoverSymbols.clear();

  const keep = new Set(watchlist.symbols.map(s => s.symbol));
  for (const symbol of [...oneMinBarHistory.keys()]) {
    if (!keep.has(symbol)) {
      oneMinBarHistory.delete(symbol);
      sessionVwapAccum.delete(symbol);
      sessionImpulseHigh.delete(symbol);
    }
  }

  for (const s of watchlist.symbols) {
    registerWatchlistSymbol(s);
    v2PersistentSymbols.add(s.symbol);
  }

  monitoredSymbols = watchlist.symbols.map(s => s.symbol);
  watchlistGeneratedAt = watchlist.generatedAt;
  watchlistTradingDay = watchlist.tradingDay ?? null;
  return monitoredSymbols;
}

function purgeMonitoredSymbol(symbol: string): void {
  orbUniverse.delete(symbol);
  preMarketGaps.delete(symbol);
  screenerDataMap.delete(symbol);
  v2PersistentSymbols.delete(symbol);
  openingRangeBar.delete(symbol);
  sessionOpenPrice.delete(symbol);
  openingDriveTriggered.delete(symbol);
  openingDriveAuditLogged.delete(symbol);
  openingDriveRejectLogged.delete(symbol);
  lastNbbo.delete(symbol);
  lastL2LogAt.delete(symbol);
  lastLoggedL2Wall.delete(symbol);
  tapeMinutes.delete(symbol);
  lastTradePrice.delete(symbol);
  oneMinBarHistory.delete(symbol);
  sessionVwapAccum.delete(symbol);
  sessionImpulseHigh.delete(symbol);
  ema9ClosePrices.delete(symbol);
  pullbackTrackers.delete(symbol);
  l2WallSignals.delete(symbol);
  l2QuotesSeen.delete(symbol);
  signalBars5m.delete(symbol);
  fiveMinAggregators.delete(symbol);
  sessionData.delete(symbol);
}

/**
 * Merge-swap the Opening Drive universe. Preserves session state for names that
 * stay (open positions, already-armed setups). Purges only the dropouts.
 */
async function swapOpeningUniverse(
  movers: WatchlistSymbol[],
): Promise<{ added: string[]; removed: string[] }> {
  const streamCap = activeStreamFeed === 'iex'
    ? config.alpaca.iexMaxStreams
    : config.alpaca.sipMaxStreams;
  const maxSymbols = Math.min(
    config.openingDrive.scannerMaxSymbols + enteredBySetup.size,
    streamCap,
  );
  const keptSymbols = capMonitoredUniverse({
    ranked: movers.map(s => s.symbol),
    entered: new Set(enteredBySetup.keys()),
    triggered: openingDriveTriggered,
    maxSymbols,
  });
  const keep = new Set(keptSymbols);

  const previous = new Set(monitoredSymbols);
  const removed = monitoredSymbols.filter(s => !keep.has(s));
  for (const symbol of removed) purgeMonitoredSymbol(symbol);

  v2PersistentSymbols.clear();
  orbUniverse.clear();
  for (const entry of movers) {
    registerWatchlistSymbol(entry);
    v2PersistentSymbols.add(entry.symbol);
  }
  for (const symbol of keep) {
    v2PersistentSymbols.add(symbol);
    orbUniverse.add(symbol);
  }

  monitoredSymbols = [...keep];
  const added = monitoredSymbols.filter(s => !previous.has(s));

  const tradingDay =
    watchlistTradingDay ??
    (await queryRequiredWatchlistTradingDay()) ??
    getSessionDateStr();
  const written = await writePremarketWatchlist(
    movers.filter(s => keep.has(s.symbol)),
    tradingDay,
  );
  watchlistGeneratedAt = written.generatedAt;
  watchlistTradingDay = written.tradingDay ?? tradingDay;

  log.info(
    `Opening universe swap — keep ${monitoredSymbols.length} ` +
    `(+${added.length} / −${removed.length})`,
  );
  return { added, removed };
}

/**
 * Seeds 1-min history and the true 09:30 opening range without replaying signals.
 */
function seedSessionBars(symbol: string, bars: BarData[]): void {
  if (bars.length === 0) return;
  for (const bar of bars) {
    pushOneMinBar(symbol, bar);
    pushEma9Close(symbol, bar.close);
  }
  const selected = selectOpeningRangeBar(bars, marketOpenMinutes());
  if (selected === null) return;
  // REST 09:30 wins: a live bar received before seed must not freeze a later open.
  sessionOpenPrice.set(symbol, selected.sessionOpen);
  openingRangeBar.set(symbol, selected.rangeBar);
}

function ensureV2SymbolsMonitored(): void {
  if (v2PersistentSymbols.size === 0) return;
  monitoredSymbols = [...new Set([...monitoredSymbols, ...v2PersistentSymbols])];
}

// ---------------------------------------------------------------------------
// Intraday cumulative VWAP
// ---------------------------------------------------------------------------

function noteSessionImpulseHigh(symbol: string, bar: BarData): void {
  if (!(bar.high > 0)) return;
  const mins = minutesSinceMidnight(toESTDate(new Date(bar.timestamp)));
  if (mins < marketOpenMinutes()) return;
  const prev = sessionImpulseHigh.get(symbol);
  if (prev === undefined || bar.high > prev) sessionImpulseHigh.set(symbol, bar.high);
}

function pushOneMinBar(symbol: string, bar: BarData): void {
  let bars = oneMinBarHistory.get(symbol);
  if (!bars) {
    bars = [];
    oneMinBarHistory.set(symbol, bars);
  }

  const last = bars[bars.length - 1];
  const acc = sessionVwapAccum.get(symbol) ?? emptyVwapAccumulator();
  if (last?.timestamp === bar.timestamp) {
    sessionVwapAccum.set(symbol, addBarToVwap(removeBarFromVwap(acc, last), bar));
    bars[bars.length - 1] = bar;
  } else {
    sessionVwapAccum.set(symbol, addBarToVwap(acc, bar));
    bars.push(bar);
    if (bars.length > ONE_MIN_HISTORY_MAX) {
      bars.splice(0, bars.length - ONE_MIN_HISTORY_MAX);
    }
  }
  noteSessionImpulseHigh(symbol, bar);
}

function closeWebSocket(): void {
  wsEnabled = false;
  if (!ws) return;
  ws.removeAllListeners();
  ws.close();
  ws = null;
  log.info('WebSocket closed cleanly');
}

function haltMarketDataIngest(): void {
  closeWebSocket();
  marketDataBus.clear();
}

async function consumeMarketData(event: MarketDataEvent): Promise<void> {
  if (event.kind === 'bar_1m') {
    await handleOneMinuteBarEvent(event.bar);
    return;
  }
  if (event.kind === 'quote') {
    handleQuoteEvent(event.quote, event.receivedAt);
    return;
  }
  if (event.kind === 'trade') {
    handleTradeEvent(event.trade);
  }
}

/**
 * Arms the live path on a trading day even when the watchlist is still empty.
 * Hyper-Growth fills the universe at 09:15; aborting here used to leave the
 * bus unstarted so 09:30 bars arrived with nobody listening.
 */
async function armLivePipeline(): Promise<void> {
  wsEnabled = true;
  if (sessionStartEquity <= 0) {
    sessionStartEquity = await trader.getAccountEquity();
    riskManager.initDailyBaseline(sessionStartEquity);
  }
  marketDataBus.start(consumeMarketData);
}

function connectWatchlistStream(extraSymbols: string[] = []): void {
  if (!wsEnabled || monitoredSymbols.length === 0) return;
  if (!ws) {
    connectWebSocket(monitoredSymbols);
    return;
  }
  if (extraSymbols.length > 0) {
    // Incremental add on an already-budgeted socket: bars only, never 3×N.
    ws.send(buildSubscribeMessage(extraSymbols, true));
  }
}

/** Tear down the current socket and subscribe only the live universe. */
function reconnectWatchlistStream(): void {
  streamBarsOnly = config.openingDrive.scannerEnabled;
  if (!wsEnabled) return;
  const stale = ws;
  ws = null;
  if (stale) {
    stale.removeAllListeners();
    stale.close();
  }
  if (monitoredSymbols.length === 0) {
    log.info('Watchlist empty — WebSocket left idle until 09:15 scan');
    return;
  }
  connectWebSocket(monitoredSymbols);
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
 * 1-min RSI from the rolling bar history — entry-timing filter to avoid buying
 * into momentum exhaustion. Returns null when history is too short (fail-open).
 */
function computeEntryRsi(symbol: string): number | null {
  const period = config.entry.entryRsiPeriod;
  const bars = oneMinBarHistory.get(symbol);
  if (!bars || bars.length < period + 1) return null;

  const values = RSI.calculate({ period, values: bars.map(b => b.close) });
  return values[values.length - 1] ?? null;
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

    const now = clampQueryEnd(
      new Date(),
      config.alpaca.streamFeed,
      config.alpaca.sipDelayMs,
    );
    const start = new Date(now.getTime() - 30 * 60 * 1000);
    const bars: BarData[] = [];
    const iter = alpaca.getBarsV2('SPY', {
      start: start.toISOString(),
      end: now.toISOString(),
      timeframe: '5Min',
      feed: config.alpaca.streamFeed,
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

function marketOpenMinutes(): number {
  return config.session.marketOpenHour * 60 + config.session.marketOpenMinute;
}

/**
 * Records the regular-session open from the bar's own timestamp.
 *
 * Wall-clock time cannot be used here: REST hydration and reconnects replay bars
 * minutes after the fact, and a pre-market bar must never be mistaken for the
 * 09:30 open — the Opening Drive extension cap is measured against this value.
 */
function captureSessionOpen(symbol: string, bar: BarData): void {
  if (sessionOpenPrice.has(symbol)) return;
  const selected = selectOpeningRangeBar(
    oneMinBarHistory.get(symbol) ?? [bar],
    marketOpenMinutes(),
  );
  if (selected === null) return;
  sessionOpenPrice.set(symbol, selected.sessionOpen);
}

function captureOpeningRange(symbol: string, bar: BarData): void {
  if (openingRangeBar.has(symbol)) return;
  const selected = selectOpeningRangeBar(
    oneMinBarHistory.get(symbol) ?? [bar],
    marketOpenMinutes(),
  );
  if (selected === null) return;
  openingRangeBar.set(symbol, selected.rangeBar);
  if (!sessionOpenPrice.has(symbol)) {
    sessionOpenPrice.set(symbol, selected.sessionOpen);
  }
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
  if (!isOrbUniverse(symbol)) return;

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

async function hydrateIntradayBars(
  symbols: string[],
  opts: { evaluate?: boolean } = {},
): Promise<void> {
  const evaluate = opts.evaluate !== false;
  if (!isRegularSessionStarted()) {
    log.info('Pre-open — intraday bar hydration skipped');
    return;
  }

  const sessionDate = getSessionDateStr();
  const end = clampQueryEnd(
    new Date(),
    config.alpaca.streamFeed,
    config.alpaca.sipDelayMs,
  ).toISOString();

  log.info(
    `Hydrating 5-min bars (${sessionDate} session, ${config.alpaca.streamFeed}) ` +
    `for ${symbols.length} symbols...`,
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
        feed: config.alpaca.streamFeed,
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

  if (!evaluate) return;

  for (const symbol of symbols) {
    const bars = signalBars5m.get(symbol);
    if (!bars || bars.length === 0) continue;

    const latest = bars[bars.length - 1];
    const gates = liveSetupGates(isOrbUniverse(symbol));
    if (gates.orb && isBlackoutPeriod()) {
      evaluateOrbSignal(symbol, latest);
    }
    if (gates.vwapPullback) {
      evaluateSignal(symbol, latest);
    }
  }
}

// ---------------------------------------------------------------------------
// Signal evaluation (VWAP breakout + volume conviction filter)
// ---------------------------------------------------------------------------

/**
 * V7 Core: VWAP breakout starts TRACKING_PULLBACK; buy signal is confirmed on later 5m bars
 * (near VWAP 0.1% + volume dry-up + green close + RVOL > min).
 * Satellite: same breakout arming; execution still via 1m tick-up (evaluatePullbackState).
 */
/**
 * Integer-share rounding at STRATEGY_CAPITAL_USD means a $56 name deploys half
 * a $110 ticket. Scale the setup score by that ratio so ranking matches dollars
 * at work. Unconstrained capital (cap 0) leaves the raw score untouched.
 */
function applyTicketEfficiency(score: number, entryPrice: number): number {
  const capital = config.risk.strategyCapitalUsd;
  if (capital <= 0) return score;
  return score * ticketEfficiencyFactor(entryPrice, capital, config.risk.maxPositionPct);
}

function queuePendingSignal(signal: PendingSignal): void {
  signalQueue.enqueue({
    ...signal,
    score: applyTicketEfficiency(signal.score, signal.barData.close),
  });
  schedulePendingSignalFlush();
}

function evaluateOrbSignal(symbol: string, latestBar: BarData): void {
  if (!config.entry.orbFiveMinEnabled) return;
  if (tradingHalted) return;
  if (hasEntered(symbol)) return;
  if (!isOrbUniverse(symbol)) return;
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

  const orbFibLevels = state.low < state.high
    ? computeFibLevels(state.low, latestBar.high)
    : null;

  const orbFibProx = orbFibLevels
    ? evaluateFibProximity(latestBar.close, orbFibLevels, config.fibonacci.proximityTolerancePct)
    : null;

  log.info(
    `${symbol}: ${formatSetupTag('ORB')} signal — ` +
    `ORB high $${state.high.toFixed(2)} | close $${latestBar.close.toFixed(2)} | ` +
    `break ${(orbDeviation * 100).toFixed(2)}% | score ${Math.round(momentumScore).toLocaleString()}` +
    (orbFibProx ? ` | ${formatFibLog(orbFibProx)}` : '') +
    ` → queued`,
  );

  queuePendingSignal({
    symbol,
    setup: 'ORB',
    score: momentumScore,
    barData: latestBar,
    vwap,
    avgVolume,
    fibLevels: orbFibLevels,
  });
}

function openingDriveWindowMinutes(): { start: number; end: number } {
  const od = config.openingDrive;
  return {
    start: od.windowStartHour * 60 + od.windowStartMinute,
    end: od.windowEndHour * 60 + od.windowEndMinute,
  };
}

function openingDriveLiveOptions(): OpeningDriveOptions {
  const od = config.openingDrive;
  const window = openingDriveWindowMinutes();
  const base: OpeningDriveOptions = {
    windowStartMinutes: window.start,
    windowEndMinutes: window.end,
    minRvol1m: od.minRvol1m,
    maxExtensionPct: od.maxExtensionPct,
    rvolBaselineBars: od.rvolBaselineBars,
    minOrbVolumeMultiple: od.minOrbVolumeMultiple,
    minCloseLocation: od.minCloseLocation,
    maxSpreadPct: od.maxSpreadPct,
    minTapeDelta: od.minTapeDelta,
    hardStopFloorPct: config.risk.hardStopFloorPct,
  };
  if (!od.scannerEnabled) return base;
  return {
    ...base,
    ...SCANNER_HOLD_GATES,
    minOpenExtensionPct: od.minOpenExtensionPct,
    maxOpenExtensionPct: od.maxOpenExtensionPct,
  };
}

function tapeDeltaForBar(symbol: string, barTimestamp: string): number | null {
  if (!config.openingDrive.tapeEnabled) return null;
  const minute = minuteEpoch(barTimestamp);
  if (minute === null) return null;
  const bucket = tapeMinutes.get(symbol)?.get(minute);
  if (!bucket) return null;
  return computeTapeDelta(bucket.buyVolume, bucket.sellVolume);
}

function rememberNbbo(quote: WsQuoteMessage): void {
  if (!(quote.bp > 0) || !(quote.ap > 0)) return;
  lastNbbo.set(quote.S, {
    bid: quote.bp,
    ask: quote.ap,
    mid: (quote.bp + quote.ap) / 2,
  });
}

function ingestSignedPrint(symbol: string, price: number, size: number, timestamp: string): void {
  const minute = minuteEpoch(timestamp);
  if (minute === null || !(price > 0) || !(size > 0)) return;

  const mid = lastNbbo.get(symbol)?.mid ?? l2WallSignals.get(symbol)?.mid ?? null;
  const prev = lastTradePrice.get(symbol) ?? null;
  const side = signPrint(price, mid, prev);
  lastTradePrice.set(symbol, price);
  if (side === 0) return;

  let buckets = tapeMinutes.get(symbol);
  if (!buckets) {
    buckets = new Map();
    tapeMinutes.set(symbol, buckets);
  }
  const current = buckets.get(minute) ?? { buyVolume: 0, sellVolume: 0 };
  if (side === 1) current.buyVolume += size;
  else current.sellVolume += size;
  buckets.set(minute, current);

  if (buckets.size > 4) {
    const keys = [...buckets.keys()].sort((a, b) => a - b);
    for (const key of keys.slice(0, keys.length - 4)) buckets.delete(key);
  }
}

/**
 * Opening Drive path. Scanner on: hold after the RTH impulse, in the
 * open-extension band, never glued to the running session high.
 */
function evaluateOpeningDriveSignal(symbol: string, bar1m: BarData): void {
  if (tradingHalted) return;
  if (hasEntered(symbol)) return;
  if (openingDriveTriggered.has(symbol)) return;
  if (config.openingDrive.scannerEnabled && !scannerMoverSymbols.has(symbol)) return;

  const screenerData = screenerDataMap.get(symbol);
  const nbbo = lastNbbo.get(symbol);
  const ctx: OpeningDriveContext = {
    symbol,
    barMinutesSinceMidnight: minutesSinceMidnight(toESTDate(new Date(bar1m.timestamp))),
    rangeBar: openingRangeBar.get(symbol) ?? null,
    previousClose: screenerData?.previousClose ?? screenerData?.lastClose ?? null,
    sessionOpen: sessionOpenPrice.get(symbol) ?? null,
    sessionVwap: resolveVwapForSymbol(symbol),
    impulseBar: bar1m,
    oneMinBars: oneMinBarHistory.get(symbol) ?? [bar1m],
    bid: nbbo?.bid ?? l2WallSignals.get(symbol)?.topBid?.price ?? null,
    ask: nbbo?.ask ?? l2WallSignals.get(symbol)?.topAsk?.price ?? null,
    tapeDelta: tapeDeltaForBar(symbol, bar1m.timestamp),
    imbalance: l2WallSignals.get(symbol)?.imbalance ?? null,
    inScanner: scannerMoverSymbols.has(symbol),
    sessionHigh: sessionImpulseHigh.get(symbol) ?? null,
  };

  const decision = evaluateOpeningDrive(ctx, openingDriveLiveOptions());

  if (!decision.armed) {
    if (isOpeningDriveFunnelRejection(decision.rejection)) {
      const key = `${symbol}:${decision.rejection}`;
      if (!openingDriveRejectLogged.has(key)) {
        openingDriveRejectLogged.add(key);
        odLog.info(
          `${symbol}: setup rejected by ${decision.rejection} — ` +
          describeOpeningDriveDecision(decision),
        );
      }
    }

    // A cap rejection is only actionable with an outcome attached: a bare counter
    // cannot say whether the cap protected the book or discarded a winner.
    if (decision.rejection === 'max_extension' && !openingDriveAuditLogged.has(symbol)) {
      openingDriveAuditLogged.add(symbol);
      shadowJournal.recordShadowSignal({
        symbol,
        signalAt: bar1m.timestamp,
        decision,
        straightRunScore: 0,
        rejectedBy: 'max_extension',
        horizonMinutes: config.openingDrive.shadowHorizonMinutes,
      });
    }
    return;
  }

  openingDriveTriggered.add(symbol);

  const banner = config.openingDrive.shadow ? 'SHADOW signal' : 'signal';
  odLog.info(
    `${symbol}: Opening Drive ${banner} — ` +
    describeOpeningDriveDecision(decision) +
    ` | score ${Math.round(decision.score).toLocaleString()}`,
  );

  // Armed setups are observed in both modes: in shadow it is the only record, and
  // live it gives the realised fill something to be compared against.
  shadowJournal.recordShadowSignal({
    symbol,
    signalAt: bar1m.timestamp,
    decision,
    straightRunScore: 0,
    rejectedBy: null,
    horizonMinutes: config.openingDrive.shadowHorizonMinutes,
  });

  if (config.openingDrive.shadow) return;

  const bars5m = signalBars5m.get(symbol) ?? [];
  const baseline = bars5m.slice(0, -1).slice(-config.entry.minBarsForVolumeAvg);
  const avgVolume = baseline.length > 0
    ? baseline.reduce((sum, b) => sum + b.volume, 0) / baseline.length
    : bar1m.volume;

  queuePendingSignal({
    symbol,
    setup: 'OPENING_DRIVE',
    score: decision.score,
    barData: bar1m,
    vwap: ctx.sessionVwap ?? bar1m.close,
    avgVolume,
    fibLevels: null,
    stopPriceOverride: decision.stopPrice,
    skipFibonacciGate: true,
  });
}

function evaluateSignal(symbol: string, latestBar: BarData): void {
  if (!config.entry.vwapPullbackEnabled) return;
  if (tradingHalted) return;
  if (hasEntered(symbol)) return;

  const existing = pullbackTrackers.get(symbol);
  if (existing) {
    if (existing.setup === 'VWAP_PULLBACK') {
      evaluateCoreV7Pullback(symbol, latestBar);
    }
    return;
  }

  if (!isCoreEntryWindowOpen()) return;

  const bars = signalBars5m.get(symbol) ?? [];
  if (bars.length < 2) return;

  const vwap = computeVwap(bars);
  if (vwap === null) return;

  const currentPrice = latestBar.close;
  const prevBar = bars[bars.length - 2];

  const vwapBreakout = prevBar.close <= vwap && currentPrice > vwap;
  if (!vwapBreakout) return;

  if (currentPrice <= vwap) return;

  const meta = screenerDataMap.get(symbol);
  if (
    isVwapLagger(
      meta?.gapUp,
      meta?.relativeReturn,
      config.entry.vwapLaggerAlphaFloor,
    )
  ) {
    log.info(
      `${symbol}: ${formatSetupTag('VWAP_PULLBACK')} skipped — lagger ` +
      `(gap ${((meta?.gapUp ?? 0) * 100).toFixed(1)}%, ` +
      `alpha ${((meta?.relativeReturn ?? 0) * 100).toFixed(1)}% ` +
      `< floor ${(config.entry.vwapLaggerAlphaFloor * 100).toFixed(0)}%)`,
    );
    return;
  }

  const recentBars = bars.slice(0, -1).slice(-config.entry.minBarsForVolumeAvg);
  const avgVolume = recentBars.length > 0
    ? recentBars.reduce((sum, b) => sum + b.volume, 0) / recentBars.length
    : latestBar.volume;

  const vwapDeviation = (currentPrice - vwap) / vwap;
  const momentumScore = latestBar.volume * latestBar.close * vwapDeviation;

  pullbackTrackers.set(symbol, {
    state: 'TRACKING_PULLBACK',
    localHigh: latestBar.high,
    prevClose: currentPrice,
    vwapAtDetection: vwap,
    setup: 'VWAP_PULLBACK',
    score: momentumScore,
    avgVolume,
    fibLevels: null,
    impulseVolumes: volumesFromBars(bars, config.entry.pullbackImpulseBars),
    pullbackVolumes: [],
  });

  log.info(
    `${symbol}: ${formatSetupTag('VWAP_PULLBACK')} breakout — tracking pullback | ` +
    `price $${currentPrice.toFixed(2)} | VWAP $${vwap.toFixed(2)} | ` +
    `deviation ${(vwapDeviation * 100).toFixed(2)}% | ` +
    `score ${Math.round(momentumScore).toLocaleString()}`,
  );
}

/**
 * V7 Core confirmation on 5m bars (no 1m tick-up / EMA9).
 * When LEVEL2_ENABLED: wall flag can unlock L2_FAST_TRIGGER or gate nominal path after quotes seen.
 */
function evaluateCoreV7Pullback(symbol: string, latestBar: BarData): void {
  if (tradingHalted || hasEntered(symbol)) {
    pullbackTrackers.delete(symbol);
    return;
  }

  const tracker = pullbackTrackers.get(symbol);
  if (!tracker || tracker.setup !== 'VWAP_PULLBACK') return;

  if (!isCoreEntryWindowOpen()) {
    if (!isBeforeCoreEntryWindow()) {
      pullbackTrackers.delete(symbol);
      log.info(`${symbol}: ${formatSetupTag('VWAP_PULLBACK')} tracker cleared — entry window closed`);
    }
    return;
  }

  if (latestBar.high > tracker.localHigh) {
    tracker.localHigh = latestBar.high;
  }

  tracker.pullbackVolumes = [...tracker.pullbackVolumes, latestBar.volume];

  const bars = signalBars5m.get(symbol) ?? [];
  const vwap = computeVwap(bars) ?? tracker.vwapAtDetection;

  if (!isNearVwap(latestBar.close, vwap, config.entry.vwapProximityPct)) return;

  if (
    !hasImpulseExtension(
      tracker.localHigh,
      vwap,
      config.entry.vwapMinExtensionPct,
    )
  ) {
    return;
  }

  const wallArmed = l2WallSignals.get(symbol)?.wall === true;
  const l2Enabled = config.level2.enabled;

  // Fast path: buy-wall + near VWAP → queue without waiting for green 5m.
  if (l2Enabled && config.level2.fastTrigger && wallArmed) {
    confirmCoreV7Entry(symbol, latestBar, tracker, vwap, bars, 'L2_FAST_TRIGGER');
    return;
  }

  if (
    !hasVolumeDryUp(
      tracker.pullbackVolumes,
      tracker.impulseVolumes,
      config.entry.pullbackDryUpRatio,
    )
  ) {
    return;
  }

  const rvol = computeIntradayRvol(latestBar, bars);
  if (!isGreenBarWithRvol(latestBar, rvol, config.entry.minRvolForPullback)) return;

  // Once quotes have been seen for this symbol, require an armed wall (graceful if never seen).
  if (l2Enabled && l2QuotesSeen.has(symbol) && !wallArmed) {
    l2Log.info(
      `${symbol}: ${formatSetupTag('VWAP_PULLBACK')} confirm blocked — L2 wall not armed ` +
      `(imbalance=${l2WallSignals.get(symbol)?.imbalance?.toFixed(2) ?? 'N/A'})`,
    );
    return;
  }

  confirmCoreV7Entry(
    symbol,
    latestBar,
    tracker,
    vwap,
    bars,
    wallArmed ? 'V7+L2_WALL' : 'V7',
  );
}

function confirmCoreV7Entry(
  symbol: string,
  latestBar: BarData,
  tracker: PullbackTracker,
  vwap: number,
  bars: BarData[],
  reason: string,
): void {
  const rvol = computeIntradayRvol(latestBar, bars);
  tracker.fibLevels = deriveFibLevelsFromBars(bars, tracker.localHigh);
  const fibProx = tracker.fibLevels
    ? evaluateFibProximity(latestBar.close, tracker.fibLevels, config.fibonacci.proximityTolerancePct)
    : null;

  pullbackTrackers.delete(symbol);
  l2WallSignals.delete(symbol);
  log.info(
    `${symbol}: ${formatSetupTag('VWAP_PULLBACK')} confirmed (${reason}) — ` +
    `close $${latestBar.close.toFixed(2)} | VWAP $${vwap.toFixed(2)} | ` +
    `rvol ${rvol === null ? 'N/A' : rvol.toFixed(2)}x` +
    (fibProx ? ` | ${formatFibLog(fibProx)}` : '') +
    ` → queued`,
  );
  queuePendingSignal({
    symbol,
    setup: 'VWAP_PULLBACK',
    score: tracker.score,
    barData: latestBar,
    vwap,
    avgVolume: tracker.avgVolume,
    fibLevels: tracker.fibLevels,
    skipFibonacciGate: VWAP_HYPER_GROWTH_GATES.skipFibonacci,
  });
}

/**
 * Satellite legacy V3 pullback on 1-min bars: support (VWAP|EMA9) then first tick up → queue.
 * Core never uses this path (V7 confirms on 5m via evaluateCoreV7Pullback).
 */
function evaluatePullbackState(symbol: string, bar1m: BarData): void {
  // Retired: Hyper-Growth confirms VWAP on 5m V7 Core (evaluateCoreV7Pullback).
  // The 1m tick-up path double-fired on V2 names and is not a second entry style.
  void symbol;
  void bar1m;
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

async function executeSignals(
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
      `  rejected  ${s.symbol.padEnd(6)} ${formatSetupTag(s.setup)} | score ${Math.round(s.score).toLocaleString()}`,
    );
  });

  for (const signal of toExecute) {
    const { symbol, barData, score, vwap, setup } = signal;

    if (setup === 'ORB') {
      const oneMinBars = oneMinBarHistory.get(symbol) ?? [];
      if (!trader.passesSatelliteVolumeConfirmation(barData, oneMinBars)) {
        log.info(
          `${symbol}: ${formatSetupTag(setup)} entry blocked — break volume ${Math.round(barData.volume)} ` +
          `≤ VMA_${config.risk.volumeConfirmationVmaPeriod}`,
        );
        continue;
      }
    }

    log.info(
      `  executing ${symbol.padEnd(6)} ${formatSetupTag(setup)} | score ${Math.round(score).toLocaleString()} ` +
      `| deviation ${(((barData.close - vwap) / vwap) * 100).toFixed(2)}% ` +
      `| price $${barData.close.toFixed(2)}`,
    );

    try {
      const asset = await alpaca.getAsset(symbol);
      if (isEtfLikeProduct({ name: asset.name, attributes: asset.attributes })) {
        log.warn(`${symbol}: entry blocked — ETF/ETP product (${asset.name})`);
        continue;
      }

      const availableBuyingPower = await trader.getAvailableBuyingPower();
      const allocation = await riskManager.getPortfolioAllocation();
      if (!allocation.canOpen) {
        log.warn(
          `${symbol}: no open slots ` +
          `(deployed $${allocation.deployed.toFixed(0)} / equity $${allocation.totalCapital.toFixed(0)}) — skipped`,
        );
        continue;
      }

      // Live ask resolved up front: every entry guard (anti-chase, VWAP distance,
      // Fibonacci, stop sizing) must judge the price we will actually pay, not the
      // stale signal bar close. The signal-batch debounce can let fast movers run
      // several % between signal and submission — that gap was the root cause of the
      // catastrophic fills (e.g. validated near VWAP at $28, filled at $32).
      const reference = await trader.getEntryReference(symbol, barData.close);
      const referencePrice = reference.price;

      const chasePct = ((referencePrice - barData.close) / barData.close) * 100;
      if (chasePct > config.entry.maxEntryChasePct) {
        log.warn(
          `${symbol}: entry blocked by anti-chase — live ask $${referencePrice.toFixed(2)} ` +
          `is ${chasePct.toFixed(2)}% above signal $${barData.close.toFixed(2)} ` +
          `(cap ${config.entry.maxEntryChasePct}%)`,
        );
        continue;
      }

      const spreadPct = computeSpreadPct(reference.bid, reference.ask);
      if (spreadPct !== null && spreadPct > config.openingDrive.maxSpreadPct) {
        log.warn(
          `${symbol}: entry blocked — live spread ${(spreadPct * 100).toFixed(2)}% ` +
          `> cap ${(config.openingDrive.maxSpreadPct * 100).toFixed(2)}%`,
        );
        continue;
      }

      const { qty, stopLossPrice, takeProfitPrice, atr } = await riskManager.computePositionSize(
        symbol,
        referencePrice,
        availableBuyingPower,
        signal.stopPriceOverride ?? null,
      );

      if (qty < 1) {
        log.warn(`${symbol}: position size 0 — ignored`);
        continue;
      }

      const screenerData = screenerDataMap.get(symbol);
      const spyTrend = await fetchSpyTrend5m();
      const filters = feedbackEngine.getFilters();

      if (
        setup === 'VWAP_PULLBACK' &&
        isVwapLagger(
          screenerData?.gapUp,
          screenerData?.relativeReturn,
          config.entry.vwapLaggerAlphaFloor,
        )
      ) {
        log.warn(
          `${symbol}: ${formatSetupTag('VWAP_PULLBACK')} entry blocked — lagger ` +
          `(gap ${((screenerData?.gapUp ?? 0) * 100).toFixed(1)}%, ` +
          `alpha ${((screenerData?.relativeReturn ?? 0) * 100).toFixed(1)}%)`,
        );
        continue;
      }

      if (
        setup === 'VWAP_PULLBACK' &&
        VWAP_HYPER_GROWTH_GATES.applySpyBearishBan &&
        shouldHardBanSpyBearish(spyTrend)
      ) {
        log.warn(
          `${symbol}: ${formatSetupTag('VWAP_PULLBACK')} entry blocked — SPY 5m bearish`,
        );
        continue;
      }

      const vwapDist = ((referencePrice - vwap) / vwap) * 100;
      const applyVwapDistanceCap =
        setup === 'ORB' ||
        (setup === 'VWAP_PULLBACK' && VWAP_HYPER_GROWTH_GATES.applyVwapDistanceCap);
      if (applyVwapDistanceCap && vwapDist > filters.maxVwapEntryDistancePct) {
        log.warn(
          `${symbol}: entry blocked by FeedbackEngine — VWAP dist ` +
          `${vwapDist.toFixed(2)}% > cap ${filters.maxVwapEntryDistancePct.toFixed(2)}%`,
        );
        continue;
      }

      const entryRsi = computeEntryRsi(symbol);
      if (setup !== 'OPENING_DRIVE' && entryRsi !== null && entryRsi > config.entry.maxEntryRsi) {
        log.warn(
          `${symbol}: entry blocked — 1-min RSI ${entryRsi.toFixed(1)} ` +
          `> cap ${config.entry.maxEntryRsi} (momentum exhaustion)`,
        );
        continue;
      }

      const gapRaw = screenerData?.gapUp ?? screenerData?.preMarketGapPct ?? null;
      const gapPct = gapRaw !== null
        ? (gapRaw <= 1 ? gapRaw * 100 : gapRaw)
        : null;
      if (
        setup !== 'OPENING_DRIVE' &&
        filters.maxGapPctForEntry !== null &&
        gapPct !== null &&
        gapPct > filters.maxGapPctForEntry
      ) {
        log.warn(
          `${symbol}: entry blocked by FeedbackEngine — gap ${gapPct.toFixed(1)}% ` +
          `> cap ${filters.maxGapPctForEntry}%`,
        );
        continue;
      }

      if (filters.atrStopTooWideWarning) {
        log.warn(
          `${symbol}: ATR stop historically too wide — consider tightening ATR_STOP_MULTIPLIER`,
        );
      }

      // Fibonacci retracement check — recomputed at execution time against current price
      let fibLevelAtEntry: number | null = null;
      let fibLevelNameAtEntry: import('./types').FibLevelName | null = null;

      if (signal.skipFibonacciGate) {
        // Continuation paths buy strength away from support; a retracement gate
        // would reject every setup they exist to take.
        log.info(`${symbol}: Fibonacci gate skipped — continuation entry path`);
      } else if (signal.fibLevels) {
        const fibProx = evaluateFibProximity(
          referencePrice,
          signal.fibLevels,
          config.fibonacci.proximityTolerancePct,
        );
        log.info(
          `${symbol}: ${formatFibLog(fibProx)} | range $${signal.fibLevels.swingLow.toFixed(2)}–$${signal.fibLevels.swingHigh.toFixed(2)}`,
        );
        if (config.fibonacci.blockEntryIfNotNear && !fibProx.isNearSupport) {
          log.warn(
            `${symbol}: entry blocked by Fibonacci — $${referencePrice.toFixed(2)} is ` +
            `${fibProx.distancePct.toFixed(2)}% from nearest ${fibProx.nearestName}% level ` +
            `(tolerance: ${config.fibonacci.proximityTolerancePct}%)`,
          );
          continue;
        }
        fibLevelAtEntry = fibProx.nearestLevel;
        fibLevelNameAtEntry = fibProx.nearestName;
      } else {
        log.info(`${symbol}: Fibonacci levels unavailable — check skipped`);
      }

      atrAtEntry.set(symbol, atr);

      const order = await trader.placeBracketOrder(
        symbol,
        qty,
        vwap,
        referencePrice,
        stopLossPrice,
        takeProfitPrice,
        setup,
        referencePrice,
      );
      enteredBySetup.set(symbol, setup);

      // Prefer the actual submitted limit price over the stale bar close (can diverge by
      // up to marketableLimitVwapMultiplier × live-ask slippage).
      const submittedLimitPrice =
        order.limit_price !== undefined && order.limit_price !== ''
          ? parseFloat(order.limit_price)
          : referencePrice;

      // Open journal record — capture all pre-trade and entry context
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
        fib_level_at_entry: fibLevelAtEntry,
        fib_level_name_at_entry: fibLevelNameAtEntry,
        equity_at_entry: allocation.totalCapital,
        risk_dollars_at_entry: resolveRiskDollarsAtEntry(
          Math.max(0, referencePrice - stopLossPrice),
          qty,
          allocation.totalCapital,
          getEffectiveRiskPerTradePct(),
        ),
      });

      executed.push(symbol);
      await saveSessionState();
    } catch (err) {
      const msg = toErrorMessage(err);
      log.error(`${symbol}: order failed — ${msg}`);
      if (isNonRetryableOrderError(msg)) {
        signalQueue.remove([symbol]);
        log.warn(`${symbol}: non-retryable order failure — dropped from queue`);
      }
      void sendTelegramAlert(formatErrorAlert(`${symbol}: ${msg}`));
    }
  }

  return executed;
}

/**
 * Unified-pool flush: remaining slots = MAX_POSITIONS − open positions.
 * VWAP_PULLBACK waits for 10:00–11:30; ORB / OPENING_DRIVE wait for the regular session.
 * Eligible candidates compete by PendingSignal.score.
 */
async function flushPendingSignals(): Promise<void> {
  signalFlushTimer = null;

  if (signalQueue.size() === 0) return;
  if (isFlushInProgress) return;

  isFlushInProgress = true;
  try {
    if (tradingHalted || riskManager.isCircuitBreakerTriggered() || riskManager.isDrawdownKillTriggered()) {
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
    const slotsAvailable = remainingPositionSlots(
      currentPositions.length,
      config.risk.maxPositions,
    );

    const pending = signalQueue.getPendingSignals().filter(s => !hasEntered(s.symbol));
    const vwapCandidates = pending.filter(s => s.setup === 'VWAP_PULLBACK');
    const sessionCandidates = pending.filter(s => s.setup !== 'VWAP_PULLBACK');

    const vwapWindowOpen = isCoreEntryWindowOpen();
    const beforeVwapWindow = isBeforeCoreEntryWindow();

    if (!vwapWindowOpen && vwapCandidates.length > 0 && sessionCandidates.length === 0) {
      if (beforeVwapWindow) {
        log.info(
          `${formatSetupTag('VWAP_PULLBACK')} window not open — ` +
          `${vwapCandidates.length} signal(s) deferred`,
        );
        schedulePendingSignalFlush();
        return;
      }
      log.info(
        `${formatSetupTag('VWAP_PULLBACK')} window closed — dropping ${vwapCandidates.length} signal(s)`,
      );
      signalQueue.removeBySetup('VWAP_PULLBACK');
      return;
    }

    const executedSymbols: string[] = [];

    const eligible: PendingSignal[] = [];
    if (vwapWindowOpen) {
      eligible.push(...vwapCandidates);
    } else if (vwapCandidates.length > 0) {
      if (beforeVwapWindow) {
        log.info(
          `${formatSetupTag('VWAP_PULLBACK')} window not open — ` +
          `${vwapCandidates.length} signal(s) kept pending`,
        );
        schedulePendingSignalFlush();
      } else {
        log.info(
          `${formatSetupTag('VWAP_PULLBACK')} window closed — dropping ${vwapCandidates.length} signal(s)`,
        );
        signalQueue.removeBySetup('VWAP_PULLBACK');
      }
    }

    if (sessionCandidates.length > 0) {
      if (!isRegularSessionStarted()) {
        log.info(
          `Pre-market — ${sessionCandidates.length} ORB/OPENING_DRIVE signal(s) held until 09:30`,
        );
        schedulePendingSignalFlush();
      } else {
        eligible.push(...sessionCandidates);
      }
    }

    eligible.sort((a, b) => b.score - a.score);

    if (eligible.length > 0) {
      log.info(
        `Flush pool — ${eligible.length} candidate(s), ` +
        `slots ${slotsAvailable}/${config.risk.maxPositions} ` +
        `(@ ${estNow.getHours()}:${String(estNow.getMinutes()).padStart(2, '0')} EST)`,
      );
      const executed = await executeSignals(eligible, slotsAvailable);
      executedSymbols.push(...executed);
    }

    signalQueue.remove(executedSymbols);

    // Keep pending VWAP_PULLBACK only while waiting for 10:00; otherwise drain.
    if (vwapWindowOpen || !beforeVwapWindow) {
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

  lastBarAt = new Date().toISOString();

  if (!liveBarsAnnounced) {
    liveBarsAnnounced = true;
    log.info(`Live 1-min bars flowing — first tick: ${symbol} @ $${barData.close.toFixed(2)}`);
  }

  pushEma9Close(symbol, barData.close);
  pushOneMinBar(symbol, barData);
  captureSessionOpen(symbol, barData);
  captureOpeningRange(symbol, barData);
  evaluatePullbackState(symbol, barData);

  // Observation before evaluation, so this bar is folded into records opened on
  // earlier bars only. A setup's own impulse bar is its entry, not an outcome.
  shadowJournal.updateShadowRecords(symbol, barData);
  evaluateOpeningDriveSignal(symbol, barData);
  if (shadowJournal.pendingFlushCount() > 0) {
    void shadowJournal.flushShadowRecords();
  }

  // UT1m dynamic exit monitoring for confirmed open positions.
  if (hasEntered(symbol)) {
    journalManager.updateExcursions(symbol, barData.close);

    try {
      await positionManager.handlePositionUpdate(
        symbol,
        barData.close,
        enteredBySetup.get(symbol) ?? 'VWAP_PULLBACK',
        {
          bar1m: barData,
          oneMinBars: oneMinBarHistory.get(symbol) ?? [barData],
          atrAtEntry: atrAtEntry.get(symbol) ?? null,
        },
      );
    } catch (err) {
      log.error(`${symbol}: position update error — ${toErrorMessage(err)}`);
    }

    if (positionManager.consumeSessionExit(symbol)) {
      enteredBySetup.delete(symbol);
      atrAtEntry.delete(symbol);
      void saveSessionState();
    }

    if (positionManager.wasExternallyExited(symbol)) {
      const exitReason = positionManager.wasScaledOut(symbol)
        ? 'trailing-stop' as const
        : 'stop-loss-initial' as const;
      journalManager.closeTrade(symbol, exitReason, barData.close);
      atrAtEntry.delete(symbol);
    }
  }

  // Circuit breaker / drawdown kill-switch — throttled to 1 REST call/minute max
  if (!tradingHalted) {
    const now = Date.now();
    if (now - lastEquityCheckMs >= EQUITY_CHECK_INTERVAL_MS) {
      lastEquityCheckMs = now;
      try {
        const equity = await trader.getAccountEquity();
        const drawdownTriggered = await riskManager.checkDailyDrawdownKillSwitch(equity);
        if (drawdownTriggered) {
          tradingHalted = true;
          haltMarketDataIngest();
          const pnlPct = (((equity - sessionStartEquity) / sessionStartEquity) * 100).toFixed(2);
          log.info(`Trading halted — daily drawdown ${pnlPct}% reached`);
          void sendTelegramAlert(
            formatErrorAlert(
              `Daily Kill-Switch déclenché — PnL ${pnlPct}%. Trading suspendu.`,
            ),
          );
          return;
        }

        const triggered = await riskManager.checkCircuitBreaker(equity);
        if (triggered) {
          tradingHalted = true;
          haltMarketDataIngest();
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

  const gates = liveSetupGates(isOrbUniverse(symbol));
  if (gates.orb && isOrbWindow()) {
    evaluateOrbSignal(symbol, completed5m);
  }
  if (gates.vwapPullback) {
    evaluateSignal(symbol, completed5m);
  }
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

function maxStreamsForActiveFeed(): number {
  return activeStreamFeed === 'sip'
    ? config.alpaca.sipMaxStreams
    : config.alpaca.iexMaxStreams;
}

function planForSymbols(symbols: string[], barsOnly = streamBarsOnly): StreamChannelPlan {
  return allocateStreamChannels(symbols, {
    maxStreams: maxStreamsForActiveFeed(),
    quotesEnabled: config.level2.enabled && !barsOnly,
    tradesEnabled: config.openingDrive.tapeEnabled && !barsOnly,
  });
}

function buildSubscribeMessage(symbols: string[], barsOnly = streamBarsOnly): string {
  const plan = planForSymbols(symbols, barsOnly);
  const payload: { action: string; bars: string[]; quotes?: string[]; trades?: string[] } = {
    action: 'subscribe',
    bars: plan.bars,
  };
  if (plan.quotes.length > 0) payload.quotes = plan.quotes;
  if (plan.trades.length > 0) payload.trades = plan.trades;
  return JSON.stringify(payload);
}

function buildUnsubscribeMessage(symbols: string[], barsOnly = streamBarsOnly): string {
  const plan = planForSymbols(symbols, barsOnly);
  const payload: { action: string; bars: string[]; quotes?: string[]; trades?: string[] } = {
    action: 'unsubscribe',
    bars: plan.bars,
  };
  if (plan.quotes.length > 0) payload.quotes = plan.quotes;
  if (plan.trades.length > 0) payload.trades = plan.trades;
  return JSON.stringify(payload);
}

/** In-place stream swap — keeps the socket, avoids a MARKET_DATA_STALE gap. */
function swapLiveStream(added: string[], removed: string[]): void {
  if (!wsEnabled) return;
  if (config.openingDrive.scannerEnabled) streamBarsOnly = true;
  if (!ws) {
    if (monitoredSymbols.length > 0) connectWebSocket(monitoredSymbols);
    return;
  }
  if (removed.length > 0) {
    ws.send(buildUnsubscribeMessage(removed, streamBarsOnly));
  }
  if (added.length > 0) {
    ws.send(buildSubscribeMessage(added, true));
  }
}

function isWsBarMessage(msg: WsMessage): msg is WsBarMessage {
  return msg.T === 'b';
}

function isWsQuoteMessage(msg: WsMessage): msg is WsQuoteMessage {
  return msg.T === 'q';
}

function isWsTradeMessage(msg: WsMessage): msg is WsTradeMessage {
  return msg.T === 't';
}

function isWsSuccessMessage(msg: WsMessage): msg is WsSuccessMessage {
  return msg.T === 'success';
}

function isWsErrorMessage(msg: WsMessage): msg is WsErrorMessage {
  return msg.T === 'error';
}

function resolveVwapForSymbol(symbol: string): number | null {
  const seeded = sessionVwapAccum.get(symbol);
  if (seeded) {
    const fromSeed = vwapFromAccumulator(seeded);
    if (fromSeed !== null) return fromSeed;
  }
  const bars = signalBars5m.get(symbol);
  if (bars && bars.length > 0) {
    return computeVwap(bars);
  }
  return sessionData.get(symbol)?.vwap ?? null;
}

function handleQuoteEvent(quote: WsQuoteMessage, receivedAt: number): void {
  rememberNbbo(quote);
  if (!config.level2.enabled) return;

  try {
    const vwap = resolveVwapForSymbol(quote.S);
    const signal = assessQuoteForWall(quote, vwap, {
      imbalanceThreshold: config.level2.imbalanceThreshold,
      vwapProximityPct: config.entry.vwapProximityPct,
      topN: config.level2.topN,
      assessedAt: receivedAt,
    });

    l2QuotesSeen.add(quote.S);
    l2WallSignals.set(quote.S, signal);

    const wallFlipped = lastLoggedL2Wall.get(quote.S) !== signal.wall;
    const lastAt = lastL2LogAt.get(quote.S);
    const due = lastAt === undefined || receivedAt - lastAt >= L2_LOG_MIN_INTERVAL_MS;
    if (wallFlipped || due) {
      lastL2LogAt.set(quote.S, receivedAt);
      lastLoggedL2Wall.set(quote.S, signal.wall);

      const bid = signal.topBid;
      const ask = signal.topAsk;
      l2Log.info(
        `${quote.S}: imbalance=${signal.imbalance === null ? 'N/A' : signal.imbalance.toFixed(3)} ` +
        `mid=${signal.mid === null ? 'N/A' : `$${signal.mid.toFixed(2)}`} ` +
        `vwap=${vwap === null ? 'N/A' : `$${vwap.toFixed(2)}`} ` +
        `bid=${bid ? `${bid.size}@${bid.price.toFixed(2)}` : 'N/A'} ` +
        `ask=${ask ? `${ask.size}@${ask.price.toFixed(2)}` : 'N/A'} ` +
        `wall=${signal.wall ? 'YES' : 'no'}`,
      );
    }
  } catch (err: unknown) {
    // Graceful degrade — never crash the bus consumer on bad quotes.
    l2Log.warn(`${quote.S}: quote handling failed — ${toErrorMessage(err)}`);
  }
}

function handleTradeEvent(trade: WsTradeMessage): void {
  try {
    ingestSignedPrint(trade.S, trade.p, trade.s, trade.t);
  } catch (err: unknown) {
    odLog.warn(`${trade.S}: trade handling failed — ${toErrorMessage(err)}`);
  }
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
      wsState = 'authenticated';
      const unique = uniqueSymbols(symbols);
      const plan = planForSymbols(symbols);
      const dropped = unique.length - plan.bars.length;
      log.info(
        `WebSocket authenticated — ${describeStreamPlan(plan)}` +
        (dropped > 0
          ? ` — dropped ${dropped} symbol(s) over ${maxStreamsForActiveFeed()}-stream cap`
          : ''),
      );
      ws?.send(buildSubscribeMessage(symbols));
    }

    if (isWsBarMessage(msg)) {
      marketDataBus.publish({
        kind: 'bar_1m',
        receivedAt: Date.now(),
        bar: msg,
      });
    }

    if (isWsQuoteMessage(msg)) {
      marketDataBus.publish({
        kind: 'quote',
        receivedAt: Date.now(),
        quote: msg,
      });
    }

    if (config.openingDrive.tapeEnabled && isWsTradeMessage(msg)) {
      marketDataBus.publish({
        kind: 'trade',
        receivedAt: Date.now(),
        trade: msg,
      });
    }

    if (isWsErrorMessage(msg)) {
      log.warn(`WebSocket error: code ${msg.code} — ${msg.msg}`);
      if (isSymbolLimitExceeded(msg.code, msg.msg)) {
        if (!streamBarsOnly) {
          streamBarsOnly = true;
          log.warn(
            'IEX symbol limit — retrying bars-only on this socket ' +
            `(${uniqueSymbols(symbols).length} names, cap ${maxStreamsForActiveFeed()} streams)`,
          );
          ws?.send(buildSubscribeMessage(symbols, true));
        } else {
          log.error('IEX symbol limit persists on bars-only — live tape stays empty');
        }
        return;
      }
      if (
        activeStreamFeed !== 'iex' &&
        !sipStreamFallbackUsed &&
        isSipStreamDenied(msg.code, msg.msg)
      ) {
        sipStreamFallbackUsed = true;
        activeStreamFeed = 'iex';
        log.warn(
          'SIP live stream refused — falling back to IEX real-time (production tape)',
        );
        const stale = ws;
        ws = null;
        if (stale) {
          stale.removeAllListeners();
          stale.close();
        }
        connectWebSocket(symbols);
        return;
      }
      if (config.level2.enabled && /quote/i.test(msg.msg)) {
        l2Log.warn(`Quote feed error — degrading to bars-only path: ${msg.msg}`);
      }
      void sendTelegramAlert(formatErrorAlert(`WebSocket: code ${msg.code} — ${msg.msg}`));
    }
  }
}

function connectWebSocket(symbols: string[]): void {
  if (!wsEnabled) {
    log.info('WebSocket disabled — market closed or idle mode');
    return;
  }

  const authMessage = JSON.stringify({
    action: 'auth',
    key: config.alpaca.keyId,
    secret: config.alpaca.secretKey,
  });

  wsState = 'connecting';
  const socket = new WebSocket(streamUrl());
  ws = socket;
  log.info(`WebSocket connecting ${streamUrl()}`);

  socket.on('open', () => {
    if (ws !== socket) return;
    reconnectAttempt = 0;
    log.info(`WebSocket connected (${activeStreamFeed}) — authenticating...`);
    socket.send(authMessage);
  });

  socket.on('message', (raw: WebSocket.RawData) => {
    if (ws !== socket) return;
    handleWsMessage(raw, symbols).catch((err: unknown) => {
      log.error(`WebSocket message handler error: ${toErrorMessage(err)}`);
    });
  });

  socket.on('close', (code: number) => {
    if (ws !== socket) return;
    wsState = 'disconnected';
    log.warn(`WebSocket closed (code ${code}) — reconnection scheduled...`);
    void sendTelegramAlert(formatErrorAlert(`WebSocket déconnecté (code ${code}) — reconnexion...`));
    scheduleReconnect(symbols);
  });

  socket.on('error', (err: Error) => {
    if (ws !== socket) return;
    log.error(`WebSocket error: ${err.message}`);
  });
}

function scheduleReconnect(symbols: string[]): void {
  if (!wsEnabled) return;

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
    void isTradingDay().then(tradingToday => {
      if (!tradingToday) {
        scheduleEodSweep();
        return;
      }
      tradingHalted = true;
      riskManager.runEodSweep(sessionData).catch((err: unknown) => {
        log.error(`EOD sweep error: ${toErrorMessage(err)}`);
      });
      // Late-session observations will never see their full horizon; a partial
      // excursion is still the calibration data we came for.
      shadowJournal.closeAllShadowRecords(new Date().toISOString());
      void shadowJournal.flushShadowRecords();
      scheduleEodSweep();
    });
  }, ms);
}

function scheduleHardClose(): void {
  const ms = msUntilESTTime(config.session.hardCloseHour, config.session.hardCloseMinute);
  log.info(`Hard close 15:58 scheduled in ${Math.round(ms / 1000 / 60)} minutes`);
  setTimeout((): void => {
    void isTradingDay().then(tradingToday => {
      if (!tradingToday) {
        scheduleHardClose();
        return;
      }
      riskManager.runHardClose()
        .then(() => haltMarketDataIngest())
        .catch((err: unknown) => {
          log.error(`Hard close error: ${toErrorMessage(err)}`);
        });
      scheduleHardClose();
    });
  }, ms);
}

// ---------------------------------------------------------------------------
// Daily lifecycle — three independent crons
// ---------------------------------------------------------------------------

// 16:00 EST: V6 post-mortem analysis (skipped when no trades closed)
function schedulePostMortem(): void {
  const ms = msUntilESTTime(config.session.postMortemHour, config.session.postMortemMinute);
  log.info(`Post-mortem 16:00 scheduled in ${Math.round(ms / 1000 / 60)} minutes`);
  setTimeout((): void => {
    void isTradingDay().then(tradingToday => {
      if (!tradingToday) {
        log.info('Post-mortem skipped — market closed today');
        schedulePostMortem();
        return;
      }
      log.info('Running V6 post-mortem analysis...');
      runPostMortem().catch((err: unknown) => {
        log.error(`Post-mortem analysis failed: ${toErrorMessage(err)}`);
      });
      schedulePostMortem();
    });
  }, ms);
}

// 16:05 EST: market fully closed → send EOD report (state untouched)
function scheduleEodReport(): void {
  const ms = msUntilESTTime(config.session.eodReportHour, config.session.eodReportMinute);
  log.info(`EOD report scheduled in ${Math.round(ms / 1000 / 60)} minutes`);
  setTimeout((): void => {
    void isTradingDay().then(tradingToday => {
      if (!tradingToday) {
        scheduleEodReport();
        return;
      }
      log.info('Sending EOD report...');
      trader.getAccountEquity()
        .then(async (endEquity) => {
          await sendDailyReport({
            startEquity: sessionStartEquity,
            endEquity,
            tradesEntered: enteredBySetup.size,
            circuitBreakerFired: riskManager.isCircuitBreakerTriggered(),
            symbols: [...enteredBySetup.keys()],
          });
        })
        .catch(() => { });

      scheduleEodReport();
    });
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
    enteredBySetup.clear();
    orbUniverse.clear();
    preMarketGaps.clear();
    screenerDataMap.clear();
    orbState.clear();
    v2PersistentSymbols.clear();
    pullbackTrackers.clear();
    ema9ClosePrices.clear();
    journalManager.reset();
    positionManager.resetSessionState();
    isFlushInProgress = false;
    monitoredSymbols = [];
    oneMinBarHistory.clear();
    sessionVwapAccum.clear();
    sessionImpulseHigh.clear();
    scannerMoverSymbols.clear();
    sessionOpenPrice.clear();
    openingRangeBar.clear();
    openingDriveTriggered.clear();
    openingDriveAuditLogged.clear();
    openingDriveRejectLogged.clear();
    lastNbbo.clear();
    lastL2LogAt.clear();
    lastLoggedL2Wall.clear();
    tapeMinutes.clear();
    lastTradePrice.clear();
    shadowJournal.closeAllShadowRecords(new Date().toISOString());
    void shadowJournal.flushShadowRecords().then(() => shadowJournal.reset());
    atrAtEntry.clear();
    signalQueue.clear();
    if (signalFlushTimer) {
      clearTimeout(signalFlushTimer);
      signalFlushTimer = null;
    }
    if (openingScannerTimer) {
      clearTimeout(openingScannerTimer);
      openingScannerTimer = null;
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

    void (async () => {
      // Run screener only after a trading session (Mon–Fri close).
      // Checking "tomorrow" would skip Friday 20:00 (tomorrow = Saturday).
      const tradingToday = await isTradingDay();

      if (!tradingToday) {
        log.info('Market closed today — Core screener skipped');
        haltMarketDataIngest();
        return;
      }

      if (!config.screener.eveningScreenerEnabled) {
        log.info('Evening Core screener disabled — Hyper-Growth universe comes from 09:15 pre-market');
        await refreshRequiredWatchlistTradingDay();
        haltMarketDataIngest();
        return;
      }

      try {
        await refreshRequiredWatchlistTradingDay();
        const watchlist = await runScreener(requiredWatchlistTradingDay ?? undefined);
        orbUniverse.clear();
        preMarketGaps.clear();
        for (const s of watchlist.symbols) {
          registerWatchlistSymbol(s);
        }
        const newSymbols = watchlist.symbols.map(s => s.symbol);
        monitoredSymbols = newSymbols;
        ensureV2SymbolsMonitored();
        watchlistGeneratedAt = watchlist.generatedAt;
        watchlistTradingDay = watchlist.tradingDay ?? null;
        log.info(`Core screener done — ${newSymbols.length} symbol(s) ready for next session`);
        haltMarketDataIngest();
        log.info('Post-session screener done — WebSocket remains closed until next trading day boot');
      } catch (err: unknown) {
        const message = toErrorMessage(err);
        log.error(`Post-session screener failed: ${message}`);
        void sendTelegramAlert(formatErrorAlert(`Post-session screener failed: ${message}`));
      }
    })();

    scheduleDailyReset();
  }, ms);
}

// 09:30 EST: market open session alert
function scheduleMarketOpenAlert(): void {
  const ms = msUntilESTTime(config.session.marketOpenHour, config.session.marketOpenMinute);
  log.info(`Market open alert 09:30 scheduled in ${Math.round(ms / 1000 / 60)} minutes`);
  setTimeout((): void => {
      void isTradingDay().then(tradingToday => {
      if (!tradingToday) {
        scheduleMarketOpenAlert();
        return;
      }
      wsEnabled = true;
      reconnectAttempt = 0;
      if (monitoredSymbols.length > 0 && !ws) {
        connectWebSocket(monitoredSymbols);
      }
      void sendTelegramAlert(
        formatStartupAlert(sessionStartEquity, config.risk.maxPositions),
      );
      scheduleMarketOpenAlert();
    });
  }, ms);
}

// 09:15 EST: pre-market broker reconciliation (post-crash / post-weekend safety net)
function schedulePreMarketReconciliation(): void {
  const ms = msUntilESTTime(config.session.preMarketHour, config.session.preMarketMinute);
  log.info(`Pre-market reconciliation scheduled in ${Math.round(ms / 1000 / 60)} minutes`);
  setTimeout((): void => {
    void isTradingDay().then(async tradingToday => {
      if (!tradingToday) {
        log.info('Pre-market skipped — market closed today');
        schedulePreMarketReconciliation();
        return;
      }
      log.info('Pre-market 09:15 — reconciliation + Satellite screener...');
      try {
        await refreshRequiredWatchlistTradingDay();
        await armLivePipeline();
        await reconcileStateFromBroker();
        await runMorningRegimeAssessment();
        if (config.openingDrive.scannerEnabled) {
          const { warmup } = await buildEligiblePool();
          const symbols = replaceMonitoredUniverse(warmup);
          await refreshRequiredWatchlistTradingDay();
          streamBarsOnly = true;
          log.info(
            `Hyper-Growth eligible pool ready — warmup ${symbols.length} symbol(s), ` +
            `scanner ${config.openingDrive.scannerStartHour}:` +
            `${String(config.openingDrive.scannerStartMinute).padStart(2, '0')}` +
            `–${config.openingDrive.scannerEndHour}:` +
            `${String(config.openingDrive.scannerEndMinute).padStart(2, '0')}`,
          );
          reconnectWatchlistStream();
        } else {
          const watchlist = await runPremarketScreener();
          if (!config.screener.eveningScreenerEnabled) {
            const symbols = replaceMonitoredUniverse(watchlist);
            await refreshRequiredWatchlistTradingDay();
            log.info(
              `Hyper-Growth universe replaced — ${symbols.length} V2_PLAYMAKER symbol(s)`,
            );
            reconnectWatchlistStream();
          } else {
            const v2Symbols = extractV2Symbols(watchlist);
            const newSymbols = applyV2WatchlistSymbols(v2Symbols);
            await refreshRequiredWatchlistTradingDay();
            log.info(
              `Play-Maker V2 done — ${v2Symbols.length} symbol(s), ` +
              `${newSymbols.length} new WebSocket subscription(s)`,
            );
            connectWatchlistStream(newSymbols);
          }
        }
      } catch (err: unknown) {
        log.error(`Pre-market routine error: ${toErrorMessage(err)}`);
      }
      schedulePreMarketReconciliation();
    });
  }, ms);
}

async function fetchOneMinuteSessionBars(symbol: string): Promise<BarData[]> {
  const estDay = getESTDate();
  const start = nyWallTimeToUtc(estDay, 4, 0);
  const end = clampQueryEnd(
    new Date(),
    config.alpaca.streamFeed,
    config.alpaca.sipDelayMs,
  );
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const bars: BarData[] = [];
      const iter = alpaca.getBarsV2(symbol, {
        start: start.toISOString(),
        end: end.toISOString(),
        timeframe: '1Min',
        feed: config.alpaca.streamFeed,
      });
      for await (const bar of iter) {
        bars.push(alpacaBarToBarData(bar));
      }
      return bars;
    } catch (err) {
      lastErr = err;
      if (!isRateLimitError(err) || attempt === 4) break;
      const delay = Math.min(500 * 2 ** (attempt - 1), 8_000);
      log.warn(
        `${symbol}: 1-min seed 429 — retry ${attempt}/4 in ${delay}ms`,
      );
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function seedNewOpeningSymbols(symbols: string[]): Promise<void> {
  if (symbols.length === 0) return;
  log.info(`Seeding 1-min bars (${config.alpaca.streamFeed}) for ${symbols.length} new mover(s)...`);
  const concurrency = 2;
  for (let i = 0; i < symbols.length; i += concurrency) {
    const batch = symbols.slice(i, i + concurrency);
    await Promise.all(batch.map(async symbol => {
      try {
        const bars = await fetchOneMinuteSessionBars(symbol);
        seedSessionBars(symbol, bars);
      } catch (err) {
        log.warn(`${symbol}: 1-min seed failed — ${toErrorMessage(err)}`);
      }
    }));
    if (i + concurrency < symbols.length) {
      await new Promise(r => setTimeout(r, 600));
    }
  }
  await hydrateIntradayBars(symbols, { evaluate: false });
}

function isOpeningScannerWindow(): boolean {
  const mins = minutesSinceMidnight(getESTDate());
  const start =
    config.openingDrive.scannerStartHour * 60 + config.openingDrive.scannerStartMinute;
  const end =
    config.openingDrive.scannerEndHour * 60 + config.openingDrive.scannerEndMinute;
  return isScannerClockWindow(mins, start, end);
}

async function runOpeningScannerTick(): Promise<void> {
  let pool = await readEligiblePool();
  if (pool === null || pool.symbols.length === 0) {
    log.warn('Opening scanner — no pool on disk, rebuilding');
    try {
      const built = await buildEligiblePool();
      pool = built.pool;
    } catch (err) {
      log.error(`Opening scanner skipped — pool rebuild failed: ${toErrorMessage(err)}`);
      return;
    }
  }
  const pinned = new Set<string>([...openingDriveTriggered, ...enteredBySetup.keys()]);
  const movers = await scanSessionExtension(pool.symbols, alpaca, {
    minPrice: config.screener.minClosePrice,
    maxPrice: config.screener.maxClosePrice,
    minExtensionPct: config.openingDrive.scannerMinExtensionPct,
    minRthDollarVolume: config.openingDrive.scannerMinRthDollarVolume,
    maxSymbols: config.openingDrive.scannerMaxSymbols,
    pinned,
  });
  scannerMoverSymbols.clear();
  for (const mover of movers) scannerMoverSymbols.add(mover.symbol);
  const { added, removed } = await swapOpeningUniverse(moversToWatchlist(movers));
  swapLiveStream(added, removed);
  if (added.length > 0) await seedNewOpeningSymbols(added);
}

function armOpeningScannerLoop(): void {
  if (openingScannerTimer) clearTimeout(openingScannerTimer);
  openingScannerTimer = setTimeout(() => {
    void (async () => {
      if (!isOpeningScannerWindow()) return;
      try {
        await runOpeningScannerTick();
      } catch (err) {
        log.error(`Opening scanner tick failed — ${toErrorMessage(err)}`);
      }
      if (isOpeningScannerWindow()) armOpeningScannerLoop();
    })();
  }, config.openingDrive.scannerIntervalSec * 1000);
}

function scheduleOpeningScanner(): void {
  if (!config.openingDrive.scannerEnabled) return;

  const startHour = config.openingDrive.scannerStartHour;
  const startMinute = config.openingDrive.scannerStartMinute;
  const delayMs = isOpeningScannerWindow()
    ? 0
    : msUntilESTTime(startHour, startMinute);

  log.info(
    delayMs === 0
      ? 'Opening scanner — already in window, first tick now'
      : `Opening scanner ${String(startHour).padStart(2, '0')}:` +
        `${String(startMinute).padStart(2, '0')} scheduled in ` +
        `${Math.round(delayMs / 1000 / 60)} minutes`,
  );

  setTimeout(() => {
    void isTradingDay().then(async tradingToday => {
      if (tradingToday && (isOpeningScannerWindow() || delayMs > 0)) {
        if (isOpeningScannerWindow() || delayMs > 0) {
          try {
            await runOpeningScannerTick();
          } catch (err) {
            log.error(`Opening scanner start failed — ${toErrorMessage(err)}`);
          }
          armOpeningScannerLoop();
        }
      }
      const nextMs = msUntilESTTime(startHour, startMinute);
      setTimeout(() => scheduleOpeningScanner(), nextMs);
    });
  }, delayMs);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log.info('Initializing trading bot...');
  log.info(
    `Market data: REST historical=${config.alpaca.dataFeed} | ` +
    `live stream=${config.alpaca.streamFeed}`,
  );
  if (config.openingDrive.shadow) {
    log.warn('OD_SHADOW=true — signals are journalled, no orders will be sent');
  } else {
    log.info(`PAPER live — orders will be sent to ${config.alpaca.baseUrl}`);
  }

  const tradingToday = await isTradingDay();
  tradingDayFlag = tradingToday;

  // Started before any await that can fail: an unreachable broker must still
  // produce a heartbeat, otherwise the watchdog cannot tell "degraded" from "dead".
  heartbeatWriter.start();
  // No-op unless POLICY_MONITOR_ENABLED=true. Alert-only; never trades.
  startPolicyMonitor();

  const symbols = await loadWatchlist(!tradingToday);
  monitoredSymbols = symbols;

  await feedbackEngine.init(config.paths.journal);

  scheduleEodSweep();
  scheduleHardClose();
  scheduleEodReport();
  schedulePostMortem();
  scheduleDailyReset();
  schedulePreMarketReconciliation();
  scheduleMarketOpenAlert();
  scheduleOpeningScanner();

  if (!tradingToday) {
    wsEnabled = false;
    wsState = 'disabled';
    log.warn(
      'Market closed today (weekend/holiday) — idle mode. ' +
      'WebSocket disabled, crons armed for next trading day.',
    );
    return;
  }

  startPositionRefreshLoop();
  await armLivePipeline();

  if (symbols.length === 0) {
    log.warn(
      'Empty watchlist at boot — pipeline armed, universe comes from 09:15 pre-market',
    );
    return;
  }

  await reconcileStateFromBroker();
  await hydrateIntradayBars(symbols);
  streamBarsOnly = config.openingDrive.scannerEnabled;
  connectWatchlistStream();

  if (config.openingDrive.tapeEnabled) {
    odLog.info(
      `TAPE enabled — ${activeStreamFeed} prints signed Lee-Ready | ` +
      `minDelta>${config.openingDrive.minTapeDelta} (fail-open when no prints)`,
    );
  }

  if (config.level2.enabled) {
    l2Log.info(
      `LEVEL2 enabled — ${activeStreamFeed} quotes subscribed | ` +
      `threshold=${config.level2.imbalanceThreshold} ` +
      `fastTrigger=${config.level2.fastTrigger} topN=${config.level2.topN}` +
      (activeStreamFeed === 'iex' ? ' (IEX effective depth=1)' : ''),
    );
  }

  const v1Count = symbols.length - orbUniverse.size;
  const v2Count = orbUniverse.size;
  log.info(
    `Bot active — ${symbols.length} symbols (${v1Count} V1_CORE, ${v2Count} V2_PLAYMAKER) | ` +
    `pool ${config.risk.maxPositions} slot(s)`,
  );
  await sendTelegramAlert(
    formatStartupAlert(sessionStartEquity, config.risk.maxPositions),
  );
  await alertInfo(
    'Bot started',
    `Monitoring ${symbols.length} symbols (${v1Count} V1_CORE, ${v2Count} V2_PLAYMAKER) | ` +
    `Equity: $${sessionStartEquity.toFixed(2)}`,
  ).catch(() => { });

}

// ---------------------------------------------------------------------------
// Graceful shutdown — saves state before PM2 kills the process
// ---------------------------------------------------------------------------

async function gracefulShutdown(signal: string): Promise<void> {
  log.warn(`Signal ${signal} received — saving state and shutting down`);
  await saveSessionState().catch(() => { });
  stopPolicyMonitor();
  // Final write then stop: the watchdog sees the last known state age out
  // naturally instead of finding a file frozen mid-session.
  heartbeatWriter.flush();
  heartbeatWriter.stop();
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
