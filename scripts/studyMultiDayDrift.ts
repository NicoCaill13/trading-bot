/**
 * Study: after a catalyst-like session, does a name keep drifting for days, and
 * does a rule on that beat a random pool name net of costs?
 *
 * The intraday studies found no gross edge from a 09:34 entry held to the close.
 * This asks the same question on another time scale, which a cash T+1 account
 * can actually trade: buy the open of E+1 after a finished event session E, sell
 * the close of E+H.
 *
 * Read-only research on daily bars. Nothing here touches the bot.
 *
 * Returns use split-adjusted bars (a reverse split would otherwise read as
 * +900%). The pool gate (price band, dollar volume) uses raw bars: adjusted
 * history would let a later reverse-split penny stock into the $5-$100 band.
 *
 * Baseline = every pool name that session, at the same horizon, so the excess
 * isolates what the event adds beyond the market of the day. Confidence
 * intervals are clustered by session.
 *
 * Known limits: the universe is today's active assets, so names delisted after
 * a pump are missing and drift is overstated; fills at the open are idealised
 * beyond the flat cost; every event x horizon is another comparison.
 *
 * Run: npx tsx scripts/studyMultiDayDrift.ts [sessions=750]
 */

import config from '../src/config';
import { getDynamicUniverse } from '../src/screener';
import { nyWallTimeToUtc } from '../src/utils';
import { fetchBars, fetchRecentSessions, type Feed, type RawBar } from './lib/barFetch';
import {
  CONTEXT_LOOKBACK,
  DRIFT_EVENTS,
  DRIFT_HORIZONS,
  EVENT_COOLDOWN_SESSIONS,
  accumulateReturns,
  accumulatorMean,
  computeDailyContext,
  emptyAccumulator,
  forwardReturnPct,
  passesPool,
  type HorizonAccumulator,
  type PoolLimits,
  type SessionOf,
} from './lib/driftStudy';
import { isDerivativeSymbol, summarizeTrades, type TradeSample } from './lib/eligibleStudy';

const FEED: Feed = 'sip';
const SESSIONS = Number(process.argv[2] ?? 750);
/** Round-trip cost charged on every event trade, in percent. */
const ROUND_TRIP_COST_PCT = 1;
const MIN_TRADES_FOR_GATE = 30;

/** Sessions fetched before the evaluation window so the first contexts have history. */
const HISTORY_SESSIONS = CONTEXT_LOOKBACK + 5;
const SYMBOL_CHUNK = 400;

const POOL: PoolLimits = {
  minPrice: config.screener.minClosePrice,
  maxPrice: config.screener.maxClosePrice,
  minDollarVolume: config.premarket.poolMinPrevDollarVolume,
};

interface EventHit {
  session: string;
  symbol: string;
  /** Gross forward return per horizon, null when not available. */
  returns: (number | null)[];
}

interface StudyState {
  baseline: Map<string, HorizonAccumulator>;
  hits: EventHit[][];
  poolRows: number;
}

function sessionDay(session: string): Date {
  const [year, month, day] = session.split('-').map(Number);
  return new Date(year, month - 1, day);
}

const dateOf = (timestamp: string): string => timestamp.slice(0, 10);

function scanSymbol(
  adjusted: readonly RawBar[],
  raw: readonly RawBar[],
  symbol: string,
  sessionOf: SessionOf,
  firstEvalSession: number,
  state: StudyState,
): void {
  const rawByDate = new Map(raw.map(bar => [dateOf(bar.t), bar]));
  const lastHitIndex = DRIFT_EVENTS.map(() => Number.NEGATIVE_INFINITY);

  for (let i = CONTEXT_LOOKBACK; i < adjusted.length; i++) {
    const sessionIndex = sessionOf(adjusted[i].t);
    if (sessionIndex === undefined || sessionIndex < firstEvalSession) continue;

    const context = computeDailyContext(adjusted, i, sessionOf);
    if (context === null) continue;

    const rawPrevious = rawByDate.get(dateOf(adjusted[i - 1].t));
    if (rawPrevious === undefined) continue;
    if (!passesPool(rawPrevious.c, rawPrevious.c * rawPrevious.v, POOL)) continue;

    const session = dateOf(adjusted[i].t);
    const returns = DRIFT_HORIZONS.map(h => forwardReturnPct(adjusted, i, h, sessionOf));

    state.poolRows++;
    let acc = state.baseline.get(session);
    if (acc === undefined) {
      acc = emptyAccumulator();
      state.baseline.set(session, acc);
    }
    accumulateReturns(acc, returns);

    DRIFT_EVENTS.forEach((event, e) => {
      if (!event.matches(context)) return;
      if (i - lastHitIndex[e] < EVENT_COOLDOWN_SESSIONS) return;
      lastHitIndex[e] = i;
      state.hits[e].push({ session, symbol, returns });
    });
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const fmt = (value: number): string => value.toFixed(2).padStart(6);

function printEventLines(
  name: string,
  hits: readonly EventHit[],
  baseline: ReadonlyMap<string, HorizonAccumulator>,
  inSegment: (session: string) => boolean,
): void {
  DRIFT_HORIZONS.forEach((horizon, hi) => {
    const absolute: TradeSample[] = [];
    const excess: TradeSample[] = [];

    for (const hit of hits) {
      const ret = hit.returns[hi];
      if (ret === null || !inSegment(hit.session)) continue;
      const acc = baseline.get(hit.session);
      const baseMean = acc === undefined ? null : accumulatorMean(acc, hi);
      if (baseMean === null) continue;

      const common = { session: hit.session, symbol: hit.symbol, outcome: 'open' as const };
      absolute.push({ ...common, netReturnPct: ret - ROUND_TRIP_COST_PCT });
      excess.push({ ...common, netReturnPct: ret - baseMean });
    }

    const abs = summarizeTrades(absolute);
    const exc = summarizeTrades(excess);
    const winRate = absolute.length > 0
      ? absolute.filter(t => t.netReturnPct > 0).length / absolute.length
      : 0;
    const gate = abs.n < MIN_TRADES_FOR_GATE
      ? 'too few'
      : abs.clusteredCi95LowPct > 0 && exc.clusteredCi95LowPct > 0 ? 'PASS' : 'fail';

    console.log(
      `  ${name.padEnd(30)} H${String(horizon).padEnd(2)} ` +
      `n ${String(abs.n).padStart(5)} days ${String(abs.days).padStart(4)} ` +
      `win ${(winRate * 100).toFixed(0).padStart(3)}% ` +
      `net ${fmt(abs.meanNetPct)}% [${fmt(abs.clusteredCi95LowPct)},${fmt(abs.clusteredCi95HighPct)}] ` +
      `pool ${fmt(abs.meanNetPct - exc.meanNetPct)}% ` +
      `excess ${fmt(exc.meanNetPct)}% [${fmt(exc.clusteredCi95LowPct)},${fmt(exc.clusteredCi95HighPct)}]  ${gate}`,
    );
  });
}

function printPoolLine(
  baseline: ReadonlyMap<string, HorizonAccumulator>,
  inSegment: (session: string) => boolean,
): void {
  const totals = emptyAccumulator();
  for (const [session, acc] of baseline) {
    if (!inSegment(session)) continue;
    DRIFT_HORIZONS.forEach((_, hi) => {
      totals.sum[hi] += acc.sum[hi];
      totals.count[hi] += acc.count[hi];
    });
  }
  const cells = DRIFT_HORIZONS.map((h, hi) => {
    const mean = accumulatorMean(totals, hi);
    return `H${h} ${mean === null ? 'n/a' : (mean - ROUND_TRIP_COST_PCT).toFixed(2)}%`;
  });
  console.log(`  pool mean net (every pool name): ${cells.join(' | ')}`);
}

function reportSegment(
  title: string,
  state: StudyState,
  inSegment: (session: string) => boolean,
): void {
  console.log(`\n${title}`);
  printPoolLine(state.baseline, inSegment);
  DRIFT_EVENTS.forEach((event, e) => {
    printEventLines(event.name, state.hits[e], state.baseline, inSegment);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const allSessions = await fetchRecentSessions(SESSIONS + HISTORY_SESSIONS);
  const sessionIndex = new Map(allSessions.map((date, i) => [date, i]));
  const sessionOf: SessionOf = timestamp => sessionIndex.get(dateOf(timestamp));
  const evalSessions = allSessions.slice(HISTORY_SESSIONS);

  console.log(
    `\nMulti-day drift study — ${FEED.toUpperCase()}, ${evalSessions.length} event sessions ` +
    `(${evalSessions[0]} .. ${evalSessions[evalSessions.length - 1]})\n` +
    `  trade   buy open of E+1, sell close of E+H for H in ${DRIFT_HORIZONS.join(', ')}; ` +
    `${ROUND_TRIP_COST_PCT}% round-trip cost\n` +
    `  pool    raw price $${POOL.minPrice}-$${POOL.maxPrice}, prev $vol >= $${POOL.minDollarVolume}\n` +
    `  returns split-adjusted | CI clustered by session | cooldown ${EVENT_COOLDOWN_SESSIONS} sessions`,
  );

  const universe = (await getDynamicUniverse()).filter(s => !isDerivativeSymbol(s));
  console.log(`  universe ${universe.length} symbols (derivatives excluded)`);

  const state: StudyState = {
    baseline: new Map(),
    hits: DRIFT_EVENTS.map(() => []),
    poolRows: 0,
  };
  const start = nyWallTimeToUtc(sessionDay(allSessions[0]), 4, 0);
  const end = nyWallTimeToUtc(sessionDay(allSessions[allSessions.length - 1]), 16, 0);

  for (let c = 0; c < universe.length; c += SYMBOL_CHUNK) {
    const chunk = universe.slice(c, c + SYMBOL_CHUNK);
    const adjusted = await fetchBars(chunk, '1Day', start, end, FEED, 'split');
    const raw = await fetchBars(chunk, '1Day', start, end, FEED, 'raw');

    for (const [symbol, bars] of adjusted) {
      const rawBars = raw.get(symbol);
      if (rawBars === undefined) continue;
      scanSymbol(bars, rawBars, symbol, sessionOf, HISTORY_SESSIONS, state);
    }
    console.log(
      `  ${Math.min(c + SYMBOL_CHUNK, universe.length)}/${universe.length} symbols | ` +
      `pool rows ${state.poolRows} | events ${state.hits.map(h => h.length).join('/')}`,
    );
  }

  const middle = evalSessions[Math.floor(evalSessions.length / 2)];
  reportSegment('ALL SESSIONS', state, () => true);
  reportSegment(`FIRST HALF (before ${middle})`, state, s => s < middle);
  reportSegment(`SECOND HALF (from ${middle})`, state, s => s >= middle);

  console.log(
    `\nCaveats: universe = today's active assets (survivorship inflates drift); ` +
    `${DRIFT_EVENTS.length * DRIFT_HORIZONS.length} event x horizon comparisons per segment; ` +
    `PASS needs n >= ${MIN_TRADES_FOR_GATE}, net CI low > 0 and excess CI low > 0.\n`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
