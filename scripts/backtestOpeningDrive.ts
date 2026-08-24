/**
 * Expectancy harness for the Opening Drive strategy.
 *
 * Rebuilds each session end to end from historical bars — pre-market funnel,
 * watchlist, signal, sizing, exit — and reports the resulting expectancy. The
 * point is to find out whether the setup has an edge before paying for a
 * real-time SIP subscription, since IEX cannot support it live.
 *
 * Faithful to production on: filter thresholds and order, the Opening Drive
 * decision function itself, sizing primitives, the anti-chase guard, the two
 * position cap, and T+1 cash (same-day proceeds are not redeployed).
 *
 * Known optimism, stated so results are not overread:
 *  - Fills assume the full size trades at one price. Real micro-cap books are
 *    thin; a 100-share market order can walk several levels.
 *  - Order book imbalance is absent from history, so that gate is skipped. Live,
 *    it can only reject trades this harness takes.
 *  - Session VWAP is built from RTH bars only. The live bot seeds it with
 *    pre-market bars, so its VWAP gate behaves slightly differently.
 *
 * Run: npx tsx scripts/backtestOpeningDrive.ts [sessions] [feed]
 */

import config from '../src/config';
import { getDynamicUniverse } from '../src/screener';
import {
  computeExpectancyMetrics,
  formatExpectancyLine,
} from '../src/expectancy';
import {
  capQtyByBuyingPower,
  capQtyByMaxNotional,
  computeRiskBasedQty,
  resolveSizingCapital,
} from '../src/riskSizing';
import { nyWallTimeToUtc } from '../src/utils';
import { fetchBars, fetchRecentSessions, type Feed } from './lib/barFetch';
import { buildSessionFunnel, type Candidate } from './lib/premarketFunnel';
import {
  findSignal,
  simulateTrade,
  type OpeningDriveOptions,
  type SimExitReason,
  type SimOptions,
  type SimRejection,
  type SimTrade,
} from './lib/openingDriveSim';
import type { BarData } from '../src/types';

const SESSIONS = Number(process.argv[2] ?? 10);
const FEED = (process.argv[3] ?? config.alpaca.dataFeed) as Feed;

/** One-way cost in basis points. Micro-caps at $1-15 routinely sit above 50. */
const SPREAD_SCENARIOS_BPS = [0, 25, 50, 100] as const;
/** Spread used for the blotter and the trail sweep. */
const REFERENCE_SPREAD_BPS = 50;

const TRADING_DAYS_PER_MONTH = 21;

const OD_OPTIONS: OpeningDriveOptions = {
  windowStartMinutes:
    config.openingDrive.windowStartHour * 60 + config.openingDrive.windowStartMinute,
  windowEndMinutes:
    config.openingDrive.windowEndHour * 60 + config.openingDrive.windowEndMinute,
  minRvol1m: config.openingDrive.minRvol1m,
  minImbalance: config.openingDrive.minImbalance,
  maxExtensionPct: config.openingDrive.maxExtensionPct,
  rvolBaselineBars: config.openingDrive.rvolBaselineBars,
  minOrbVolumeMultiple: config.openingDrive.minOrbVolumeMultiple,
  hardStopFloorPct: config.risk.hardStopFloorPct,
};

interface SessionData {
  session: string;
  watchlist: Candidate[];
  /** RTH 1-min bars per symbol, ascending, starting at the session open. */
  bars: Map<string, BarData[]>;
}

interface SessionResult {
  session: string;
  watchlistSize: number;
  signals: number;
  trades: SimTrade[];
  rejections: SimRejection[];
  startEquity: number;
  endEquity: number;
}

interface RunResult {
  sessions: SessionResult[];
  trades: SimTrade[];
  finalEquity: number;
}

function toBarData(raw: { t: string; o: number; h: number; l: number; c: number; v: number }): BarData {
  return {
    open: raw.o,
    high: raw.h,
    low: raw.l,
    close: raw.c,
    volume: raw.v,
    timestamp: raw.t,
  };
}

async function loadSession(
  universe: readonly string[],
  session: string,
): Promise<SessionData> {
  const { watchlist } = await buildSessionFunnel(universe, session, FEED);
  if (watchlist.length === 0) {
    return { session, watchlist, bars: new Map() };
  }

  const [year, month, day] = session.split('-').map(Number);
  const estDay = new Date(year, month - 1, day);
  const rthStart = nyWallTimeToUtc(estDay, 9, 30);
  const rthEnd = nyWallTimeToUtc(estDay, 16, 0);

  const raw = await fetchBars(
    watchlist.map(c => c.symbol),
    '1Min',
    rthStart,
    rthEnd,
    FEED,
  );

  const bars = new Map<string, BarData[]>();
  for (const [symbol, list] of raw) {
    const rth = list
      .filter(b => Date.parse(b.t) >= rthStart.getTime())
      .sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
      .map(toBarData);
    if (rth.length > 0) bars.set(symbol, rth);
  }

  return { session, watchlist, bars };
}

/**
 * Replays one session. Signals from every watchlist symbol compete in
 * chronological order, which is how the live bot fills its slots.
 */
function runSession(
  data: SessionData,
  startEquity: number,
  simOptions: SimOptions,
): SessionResult {
  const result: SessionResult = {
    session: data.session,
    watchlistSize: data.watchlist.length,
    signals: 0,
    trades: [],
    rejections: [],
    startEquity,
    endEquity: startEquity,
  };

  const sizingCapital = resolveSizingCapital(startEquity, config.risk.strategyCapitalUsd);
  const candidates: { candidate: Candidate; bars: BarData[]; signalIndex: number; signalClose: number; stopPriceOverride: number }[] = [];

  for (const candidate of data.watchlist) {
    const bars = data.bars.get(candidate.symbol);
    if (!bars || bars.length === 0) continue;

    const signal = findSignal(
      candidate.symbol,
      bars,
      candidate.previousClose,
      OD_OPTIONS,
    );
    if (!signal) continue;

    result.signals++;
    candidates.push({ candidate, bars, ...signal });
  }

  candidates.sort(
    (a, b) =>
      Date.parse(a.bars[a.signalIndex].timestamp) -
      Date.parse(b.bars[b.signalIndex].timestamp),
  );

  // T+1: proceeds settle overnight, so intraday capital is spent, not recycled.
  let availableToday = sizingCapital;
  let realized = 0;

  for (const entry of candidates) {
    if (result.trades.length >= config.risk.maxPositions) break;

    const outcome = simulateTrade(
      entry.candidate.symbol,
      data.session,
      entry.bars,
      {
        signalIndex: entry.signalIndex,
        signalClose: entry.signalClose,
        stopPriceOverride: entry.stopPriceOverride,
      },
      simOptions,
      (entryPrice, stopDistance) => {
        const riskQty = computeRiskBasedQty(
          sizingCapital,
          config.risk.riskPerTradePct,
          entryPrice,
          entryPrice - stopDistance,
        );
        const notionalCapped = capQtyByMaxNotional(
          riskQty,
          entryPrice,
          sizingCapital,
          config.risk.maxPositionPct,
        );
        return capQtyByBuyingPower(notionalCapped, entryPrice, availableToday);
      },
    );

    if (outcome.kind === 'rejected') {
      result.rejections.push(outcome.reason);
      continue;
    }
    if (outcome.kind === 'no_signal') continue;

    availableToday -= outcome.trade.entryPrice * outcome.trade.qty;
    realized += outcome.trade.netPnl;
    result.trades.push(outcome.trade);
  }

  result.endEquity = startEquity + realized;
  return result;
}

function baseSimOptions(spreadBps: number): SimOptions {
  return {
    spreadPctOneWay: spreadBps / 10_000,
    maxEntryChasePct: config.entry.maxEntryChasePct,
    hardStopFloorPct: config.risk.hardStopFloorPct,
    trailTriggerPct: config.risk.atrTrailTriggerPct,
    trailPct: config.risk.trailingStopPct,
    timeStopMinutes: config.risk.timeStopMinutes,
    hardCloseMinutes: config.session.hardCloseHour * 60 + config.session.hardCloseMinute,
  };
}

function runAll(sessions: readonly SessionData[], simOptions: SimOptions): RunResult {
  let equity = resolveSizingCapital(
    config.risk.strategyCapitalUsd > 0 ? config.risk.strategyCapitalUsd : 200,
    config.risk.strategyCapitalUsd,
  );
  const results: SessionResult[] = [];
  const trades: SimTrade[] = [];

  for (const data of sessions) {
    const result = runSession(data, equity, simOptions);
    equity = result.endEquity;
    results.push(result);
    trades.push(...result.trades);
  }

  return { sessions: results, trades, finalEquity: equity };
}

function pct(value: number): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;
}

function reportRun(run: RunResult, spreadBps: number, startEquity: number): void {
  const label = `spread ${spreadBps}bps one-way (${(spreadBps / 50).toFixed(2)}% round trip)`;
  console.log(`\n══ ${label} ${'═'.repeat(Math.max(0, 50 - label.length))}`);

  if (run.trades.length === 0) {
    console.log('  no trades');
    return;
  }

  const metrics = computeExpectancyMetrics(
    run.trades.map(t => ({ exit_time: t.exitTime, pnl_r: t.pnlR })),
  );
  console.log(`  ${formatExpectancyLine('expectancy', metrics)}`);

  const totalReturn = (run.finalEquity - startEquity) / startEquity;
  const perSession = run.sessions.length > 0 ? totalReturn / run.sessions.length : 0;
  console.log(
    `  equity $${startEquity.toFixed(2)} → $${run.finalEquity.toFixed(2)} ` +
    `(${pct(totalReturn)} over ${run.sessions.length} sessions, ${pct(perSession)}/session avg)`,
  );

  const monthlyEquivalent = perSession * TRADING_DAYS_PER_MONTH;
  console.log(
    `  extrapolated monthly ${pct(monthlyEquivalent)} ` +
    `(target +41.00%, requires ${pct(0.41 / TRADING_DAYS_PER_MONTH)}/session)`,
  );

  const byReason = new Map<SimExitReason, number>();
  for (const t of run.trades) {
    byReason.set(t.exitReason, (byReason.get(t.exitReason) ?? 0) + 1);
  }
  console.log(
    `  exits ${[...byReason].map(([r, n]) => `${r}=${n}`).join(' ')}`,
  );

  const reachedTrail = run.trades.filter(
    t => t.mfePct >= config.risk.atrTrailTriggerPct,
  ).length;
  const mfes = run.trades.map(t => t.mfePct).sort((a, b) => a - b);
  const median = mfes[Math.floor(mfes.length / 2)];
  console.log(
    `  MFE median ${pct(median)} max ${pct(mfes[mfes.length - 1])} | ` +
    `reached trail trigger (${pct(config.risk.atrTrailTriggerPct)}): ` +
    `${reachedTrail}/${run.trades.length}`,
  );

  const halted = run.trades.filter(t => t.haltGapCount > 0).length;
  const jumped = run.trades.filter(t => t.gappedThroughStop).length;
  console.log(
    `  halt exposure ${halted}/${run.trades.length} trades held through a bar gap | ` +
    `stop jumped on ${jumped}`,
  );
}

/**
 * Grid over the trail parameters at a fixed spread. Answers whether any trail
 * setting turns the observed distribution positive, or whether the entry itself
 * is the problem.
 */
function reportTrailSweep(sessions: readonly SessionData[], spreadBps: number): void {
  const triggers = [0.04, 0.06, 0.08, 0.10, 0.15, 0.20];
  const trails = [0.03, 0.05, 0.08, 0.12];

  console.log(
    `\n── trail sweep at ${spreadBps}bps: E(R) by trigger x trail ` + '─'.repeat(20),
  );
  console.log(
    '  trigger  ' + trails.map(t => `trail ${pct(t).padStart(7)}`).join('  '),
  );

  for (const trigger of triggers) {
    const cells = trails.map(trail => {
      const run = runAll(sessions, {
        ...baseSimOptions(spreadBps),
        trailTriggerPct: trigger,
        trailPct: trail,
      });
      const metrics = computeExpectancyMetrics(
        run.trades.map(t => ({ exit_time: t.exitTime, pnl_r: t.pnlR })),
      );
      const e = metrics.eR;
      return `${e >= 0 ? '+' : ''}${e.toFixed(2)}R`.padStart(13);
    });
    console.log(`  ${pct(trigger).padStart(7)}  ${cells.join('  ')}`);
  }
}

function reportBlotter(run: RunResult): void {
  console.log('\n── blotter (reference spread) ' + '─'.repeat(45));
  for (const s of run.sessions) {
    const rejects = s.rejections.length > 0 ? ` rejected=${s.rejections.join(',')}` : '';
    console.log(
      `  ${s.session} watchlist=${String(s.watchlistSize).padStart(2)} ` +
      `signals=${s.signals} trades=${s.trades.length}${rejects} ` +
      `equity $${s.startEquity.toFixed(2)} → $${s.endEquity.toFixed(2)}`,
    );
    for (const t of s.trades) {
      console.log(
        `      ${t.symbol.padEnd(6)} ${t.entryTime.slice(11, 16)}→${t.exitTime.slice(11, 16)} ` +
        `${String(t.qty).padStart(3)}sh @ $${t.entryPrice.toFixed(2)} ` +
        `stop $${t.stopPrice.toFixed(2)} exit $${t.exitPrice.toFixed(2)} ` +
        `${t.exitReason.padEnd(13)} MFE ${pct(t.mfePct).padStart(8)} ` +
        `pnl ${(t.netPnl >= 0 ? '+' : '') + t.netPnl.toFixed(2)} (${t.pnlR.toFixed(2)}R)` +
        `${t.haltGapCount > 0 ? ` [halts=${t.haltGapCount}${t.gappedThroughStop ? ' JUMPED' : ''}]` : ''}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const universe = await getDynamicUniverse();
  const sessionDates = await fetchRecentSessions(SESSIONS);

  console.log(
    `\nOpening Drive expectancy — ${FEED.toUpperCase()} feed, ${sessionDates.length} sessions\n` +
    `  screener  price $${config.screener.minClosePrice}-$${config.screener.maxClosePrice} | ` +
    `gap >= ${pct(config.premarket.minGapUpPct)} | ` +
    `pm volume >= ${(config.premarket.minPreMarketShareVolume / 1e6).toFixed(1)}M\n` +
    `  entry     window ${OD_OPTIONS.windowStartMinutes / 60 | 0}:` +
    `${String(OD_OPTIONS.windowStartMinutes % 60).padStart(2, '0')}-` +
    `${OD_OPTIONS.windowEndMinutes / 60 | 0}:` +
    `${String(OD_OPTIONS.windowEndMinutes % 60).padStart(2, '0')} EST | ` +
    `rvol >= ${OD_OPTIONS.minRvol1m}x | orb vol >= ${OD_OPTIONS.minOrbVolumeMultiple}x | ` +
    `ext cap ${pct(OD_OPTIONS.maxExtensionPct)}\n` +
    `  risk      ${pct(config.risk.riskPerTradePct)}/trade | ` +
    `notional cap ${pct(config.risk.maxPositionPct)} | ` +
    `floor ${pct(config.risk.hardStopFloorPct)} | ` +
    `trail ${pct(config.risk.trailingStopPct)} armed at ${pct(config.risk.atrTrailTriggerPct)} | ` +
    `time stop ${config.risk.timeStopMinutes}min | max ${config.risk.maxPositions} pos`,
  );

  const loaded: SessionData[] = [];
  for (const session of sessionDates) {
    // One bad session must not discard the whole sweep.
    try {
      const data = await loadSession(universe, session);
      loaded.push(data);
      console.log(
        `  ${session} watchlist ${data.watchlist.length}, bars for ${data.bars.size} symbol(s)`,
      );
    } catch (err: unknown) {
      console.log(
        `  ${session} SKIPPED — ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
      );
    }
  }

  const startEquity = config.risk.strategyCapitalUsd > 0
    ? config.risk.strategyCapitalUsd
    : 200;

  let reference: RunResult | null = null;
  for (const bps of SPREAD_SCENARIOS_BPS) {
    const run = runAll(loaded, baseSimOptions(bps));
    reportRun(run, bps, startEquity);
    if (bps === REFERENCE_SPREAD_BPS) reference = run;
  }

  reportTrailSweep(loaded, REFERENCE_SPREAD_BPS);
  if (reference) reportBlotter(reference);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
