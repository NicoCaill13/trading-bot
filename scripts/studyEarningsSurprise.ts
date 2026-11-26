/**
 * Study: after a quarterly results release, does a large positive earnings
 * surprise (SUE >= 2) keep drifting for days, net of costs, beyond the other
 * earnings events of the same week?
 *
 * Pre-registered in prereg-earnings-surprise.md before any return was computed;
 * the decision rule lives in lib/earningsVerdict.ts. Read-only research on daily
 * bars and SEC EDGAR data. Nothing here touches the bot.
 *
 * Trade: buy the open of E+1, sell the close of E+5, where E is the first session
 * that could react to the 8-K item 2.02 press release. Returns are split-adjusted;
 * the pool gate uses the previous session's raw close and dollar volume.
 * Confidence intervals are clustered by session.
 *
 * Known limits: the universe is today's active assets (survivorship); quarters
 * without a datable 8-K, without a diluted-EPS tag, or older than the
 * submissions "recent" window are excluded and counted in the funnel; EPS comes
 * from the 10-Q and is assumed equal to the press release.
 *
 * Run: npx tsx scripts/studyEarningsSurprise.ts [sessions=750]
 */

import config from '../src/config';
import { getDynamicUniverse } from '../src/screener';
import { nyWallTimeToUtc } from '../src/utils';
import { fetchBars, fetchRecentSessions, sessionDay, type Feed, type RawBar } from './lib/barFetch';
import {
  DRIFT_HORIZONS,
  accumulateReturns,
  accumulatorMean,
  emptyAccumulator,
  forwardReturnPct,
  passesPool,
  type HorizonAccumulator,
  type PoolLimits,
  type SessionOf,
} from './lib/driftStudy';
import { findEarningsRelease, timeRelease } from './lib/earningsEvents';
import {
  SUE_THRESHOLD,
  computeSue,
  excessVsWeekBaseline,
  parseQuarterlyEps,
  type EarningsEvent,
  type QuarterEps,
} from './lib/earningsSurprise';
import {
  MAX_LATE_SHARE,
  MAX_MDE_PCT,
  MIN_EVENTS,
  addToRunningStats,
  decideVerdict,
  emptyRunningStats,
  minimumDetectableEffectPct,
  sampleStdDev,
  type RunningStats,
} from './lib/earningsVerdict';
import { createEdgarClient, type EdgarClient } from './lib/edgarClient';
import { cikForSymbol, parseEpsFacts, parseFilings, parseTickerMap, type Filing } from './lib/edgarParse';
import { isDerivativeSymbol, summarizeTrades, type TradeSample, type TradeStats } from './lib/eligibleStudy';

const FEED: Feed = 'sip';
const SESSIONS = Number(process.argv[2] ?? 750);
/** Round-trip cost charged on every trade, in percent. Assumed, not measured. */
const ROUND_TRIP_COST_PCT = 1;
/** Sessions before this date were never looked at: the true out-of-sample (as in studyEligibleMovers). */
const SEEN_FROM = '2026-08-19';
const DECISIVE_HORIZON = 5;
const DECISIVE_INDEX = DRIFT_HORIZONS.indexOf(DECISIVE_HORIZON);
/** Decisive horizon plus the two pre-declared exploratory ones. */
const REPORTED_HORIZONS: readonly number[] = [1, 3, 5];
const SYMBOL_CHUNK = 400;
const PROGRESS_EVERY = 100;

const POOL: PoolLimits = {
  minPrice: config.screener.minClosePrice,
  maxPrice: config.screener.maxClosePrice,
  minDollarVolume: config.premarket.poolMinPrevDollarVolume,
};

const dateOf = (timestamp: string): string => timestamp.slice(0, 10);
const fmt = (value: number): string => value.toFixed(2).padStart(6);

interface Candidate {
  symbol: string;
  adjusted: RawBar[];
  rawByDate: Map<string, RawBar>;
}

interface PoolState {
  /** Mean forward return of every pool name per session, for the pool-wide baseline. */
  baseline: Map<string, HorizonAccumulator>;
  /** Spread of 5-day returns across all pool rows, for the detectable effect. */
  decisiveReturns: RunningStats;
  /** Symbols that were in the pool at least once. */
  candidates: Candidate[];
  rows: number;
}

interface EarningsHit {
  symbol: string;
  /** Reaction session E, YYYY-MM-DD. */
  session: string;
  sue: number;
  /** Gross forward return per DRIFT_HORIZONS entry, null when not available. */
  returns: (number | null)[];
  /** Sessions between the release and the 10-Q. */
  gapSessions: number;
}

interface Funnel {
  noCik: number;
  noEps: number;
  quarters: number;
  noSue: number;
  noRelease: number;
  untimed: number;
  noBar: number;
  outOfPool: number;
}

const emptyFunnel = (): Funnel => ({
  noCik: 0, noEps: 0, quarters: 0, noSue: 0, noRelease: 0, untimed: 0, noBar: 0, outOfPool: 0,
});

interface HitContext {
  sessions: readonly string[];
  sessionOf: SessionOf;
  client: EdgarClient;
  tickers: ReadonlyMap<string, string>;
}

// ---------------------------------------------------------------------------
// Step 1: the pool, from daily bars
// ---------------------------------------------------------------------------

function scanPool(
  symbol: string,
  adjusted: readonly RawBar[],
  raw: readonly RawBar[],
  sessions: readonly string[],
  sessionOf: SessionOf,
  pool: PoolState,
): void {
  const rawByDate = new Map(raw.map(bar => [dateOf(bar.t), bar]));
  let inPool = false;

  for (let i = 0; i < adjusted.length; i++) {
    const index = sessionOf(adjusted[i].t);
    if (index === undefined || index < 1) continue;

    const previous = rawByDate.get(sessions[index - 1]);
    if (previous === undefined || !passesPool(previous.c, previous.c * previous.v, POOL)) continue;

    inPool = true;
    pool.rows++;
    const returns = DRIFT_HORIZONS.map(h => forwardReturnPct(adjusted, i, h, sessionOf));

    const session = dateOf(adjusted[i].t);
    let acc = pool.baseline.get(session);
    if (acc === undefined) {
      acc = emptyAccumulator();
      pool.baseline.set(session, acc);
    }
    accumulateReturns(acc, returns);

    const decisive = returns[DECISIVE_INDEX];
    if (decisive !== null) addToRunningStats(pool.decisiveReturns, decisive);
  }

  if (inPool) pool.candidates.push({ symbol, adjusted: [...adjusted], rawByDate });
}

// ---------------------------------------------------------------------------
// Step 2: earnings events, from EDGAR
// ---------------------------------------------------------------------------

function hitsForSymbol(
  candidate: Candidate,
  series: readonly QuarterEps[],
  filings: readonly Filing[],
  ctx: HitContext,
  funnel: Funnel,
): EarningsHit[] {
  const barIndex = new Map(candidate.adjusted.map((bar, i) => [dateOf(bar.t), i]));
  const hits: EarningsHit[] = [];

  series.forEach((quarter, q) => {
    if (quarter.filed < ctx.sessions[0]) return;
    funnel.quarters++;

    const reading = computeSue(series, q);
    if (reading === null) { funnel.noSue++; return; }

    const release = findEarningsRelease(quarter, filings);
    if (release === null) { funnel.noRelease++; return; }

    const timing = timeRelease(ctx.sessions, release, quarter);
    if (timing === null || timing.reactionIndex < 1) { funnel.untimed++; return; }

    const session = ctx.sessions[timing.reactionIndex];
    const i = barIndex.get(session);
    if (i === undefined) { funnel.noBar++; return; }

    const previous = candidate.rawByDate.get(ctx.sessions[timing.reactionIndex - 1]);
    if (previous === undefined || !passesPool(previous.c, previous.c * previous.v, POOL)) {
      funnel.outOfPool++;
      return;
    }

    hits.push({
      symbol: candidate.symbol,
      session,
      sue: reading.sue,
      gapSessions: timing.gapSessions,
      returns: DRIFT_HORIZONS.map(h => forwardReturnPct(candidate.adjusted, i, h, ctx.sessionOf)),
    });
  });

  return hits;
}

async function collectHits(
  candidates: readonly Candidate[],
  ctx: HitContext,
  funnel: Funnel,
): Promise<EarningsHit[]> {
  const hits: EarningsHit[] = [];

  for (const [n, candidate] of candidates.entries()) {
    if (n > 0 && n % PROGRESS_EVERY === 0) {
      console.log(`  edgar ${n}/${candidates.length} symbols | eligible events ${hits.length}`);
    }
    const cik = cikForSymbol(ctx.tickers, candidate.symbol);
    if (cik === null) { funnel.noCik++; continue; }

    const series = parseQuarterlyEps(parseEpsFacts(await ctx.client.epsConcept(cik)));
    if (series.length === 0) { funnel.noEps++; continue; }

    const filings = parseFilings(await ctx.client.submissions(cik));
    hits.push(...hitsForSymbol(candidate, series, filings, ctx, funnel));
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Step 3: statistics and report
// ---------------------------------------------------------------------------

interface HorizonResult {
  /** Selected events (SUE >= threshold), net of the round-trip cost. */
  absolute: TradeSample[];
  /** Selected events minus the same-ISO-week baseline of non-selected events. */
  excessWeek: TradeSample[];
  /** Selected events minus the mean of every pool name that session (exploratory). */
  excessPool: TradeSample[];
}

const asSample = (symbol: string, session: string, netReturnPct: number): TradeSample => ({
  symbol,
  session,
  outcome: 'open',
  netReturnPct,
});

function evaluateHorizon(
  hits: readonly EarningsHit[],
  horizonIndex: number,
  baseline: ReadonlyMap<string, HorizonAccumulator>,
): HorizonResult {
  const events = hits.flatMap((hit): EarningsEvent[] => {
    const returnPct = hit.returns[horizonIndex];
    return returnPct === null ? [] : [{ symbol: hit.symbol, session: hit.session, sue: hit.sue, returnPct }];
  });
  const selected = events.filter(event => event.sue >= SUE_THRESHOLD);
  const { samples } = excessVsWeekBaseline(events, SUE_THRESHOLD);

  return {
    absolute: selected.map(e => asSample(e.symbol, e.session, e.returnPct - ROUND_TRIP_COST_PCT)),
    excessWeek: samples.map(s => asSample(s.symbol, s.session, s.excessPct)),
    excessPool: selected.flatMap(e => {
      const acc = baseline.get(e.session);
      const mean = acc === undefined ? null : accumulatorMean(acc, horizonIndex);
      return mean === null ? [] : [asSample(e.symbol, e.session, e.returnPct - mean)];
    }),
  };
}

const band = (stats: TradeStats): string =>
  `${fmt(stats.meanNetPct)}% [${fmt(stats.clusteredCi95LowPct)},${fmt(stats.clusteredCi95HighPct)}]`;

function printSegment(
  title: string,
  horizon: number,
  result: HorizonResult,
  inSegment: (sample: TradeSample) => boolean,
): void {
  const absolute = summarizeTrades(result.absolute.filter(inSegment));
  const week = summarizeTrades(result.excessWeek.filter(inSegment));
  const pool = summarizeTrades(result.excessPool.filter(inSegment));
  console.log(
    `  ${title.padEnd(14)} H${String(horizon).padEnd(2)} ` +
    `n ${String(absolute.n).padStart(5)} days ${String(absolute.days).padStart(4)}  ` +
    `net ${band(absolute)}  excess(week, n ${week.n}) ${band(week)}  excess(pool) ${band(pool)}`,
  );
}

function printFunnel(funnel: Funnel, candidates: number, eligible: number): void {
  console.log(
    `\nFunnel\n` +
    `  symbols in the pool at least once   ${candidates}\n` +
    `    no CIK / no diluted-EPS series    ${funnel.noCik} / ${funnel.noEps}\n` +
    `  quarters filed in the window        ${funnel.quarters}\n` +
    `    SUE not computable                ${funnel.noSue}\n` +
    `    no datable 8-K item 2.02          ${funnel.noRelease}  (excluded: selection bias)\n` +
    `    release or 10-Q outside calendar  ${funnel.untimed}\n` +
    `    no bar on the reaction session    ${funnel.noBar}\n` +
    `    outside the pool the day before   ${funnel.outOfPool}\n` +
    `  eligible events                     ${eligible}`,
  );
}

function report(hits: readonly EarningsHit[], pool: PoolState, funnel: Funnel): void {
  printFunnel(funnel, pool.candidates.length, hits.length);

  const decisive = evaluateHorizon(hits, DECISIVE_INDEX, pool.baseline);
  const isOutOfSample = (s: TradeSample): boolean => s.session < SEEN_FROM;
  const isSeen = (s: TradeSample): boolean => s.session >= SEEN_FROM;

  // Pre-declared checks come before any mean is printed.
  const selectedOutOfSample = decisive.absolute.filter(isOutOfSample).length;
  const poolStdDev = sampleStdDev(pool.decisiveReturns);
  const mde = minimumDetectableEffectPct(poolStdDev, selectedOutOfSample);
  const lateShare = hits.length > 0 ? hits.filter(h => h.gapSessions > 1).length / hits.length : 0;
  console.log(
    `\nPre-declared checks\n` +
    `  detectable effect  ${mde.toFixed(2)}% (pool 5-day sd ${poolStdDev.toFixed(2)}%, ` +
    `n ${selectedOutOfSample} out-of-sample)  limit ${MAX_MDE_PCT}%\n` +
    `  10-Q lag > 1 session  ${(lateShare * 100).toFixed(1)}% of events  limit ${MAX_LATE_SHARE * 100}%`,
  );

  console.log(`\nDecisive: SUE >= ${SUE_THRESHOLD}, H${DECISIVE_HORIZON}, ${ROUND_TRIP_COST_PCT}% round-trip cost`);
  printSegment('OUT-OF-SAMPLE', DECISIVE_HORIZON, decisive, isOutOfSample);
  printSegment('SEEN', DECISIVE_HORIZON, decisive, isSeen);

  console.log('\nExploratory (never decisive)');
  for (const horizon of REPORTED_HORIZONS.filter(h => h !== DECISIVE_HORIZON)) {
    const result = evaluateHorizon(hits, DRIFT_HORIZONS.indexOf(horizon), pool.baseline);
    printSegment('OUT-OF-SAMPLE', horizon, result, isOutOfSample);
    printSegment('SEEN', horizon, result, isSeen);
  }

  const seenAbsolute = summarizeTrades(decisive.absolute.filter(isSeen));
  const seenExcess = summarizeTrades(decisive.excessWeek.filter(isSeen));
  const verdict = decideVerdict({
    mdePct: mde,
    lateShare,
    oosAbsolute: summarizeTrades(decisive.absolute.filter(isOutOfSample)),
    oosExcess: summarizeTrades(decisive.excessWeek.filter(isOutOfSample)),
    seenAbsoluteMeanPct: seenAbsolute.n > 0 ? seenAbsolute.meanNetPct : null,
    seenExcessMeanPct: seenExcess.n > 0 ? seenExcess.meanNetPct : null,
  });

  console.log(
    `\nVERDICT: ${verdict}\n` +
    `  PASS needs: detectable effect <= ${MAX_MDE_PCT}%, 10-Q lag share <= ${MAX_LATE_SHARE * 100}%, ` +
    `n >= ${MIN_EVENTS} out-of-sample, clustered CI low > 0 for net and for excess(week), ` +
    `and a positive mean on the seen sessions.\n` +
    `Caveats: universe = today's active assets (survivorship); quarters without a datable 8-K are ` +
    `excluded; ${ROUND_TRIP_COST_PCT}% cost is an assumption; EPS taken from the 10-Q.\n`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const sessions = await fetchRecentSessions(SESSIONS + 1);
  const sessionIndex = new Map(sessions.map((date, i) => [date, i]));
  const sessionOf: SessionOf = timestamp => sessionIndex.get(dateOf(timestamp));

  console.log(
    `\nEarnings-surprise study — ${FEED.toUpperCase()}, ${sessions.length} sessions ` +
    `(${sessions[0]} .. ${sessions[sessions.length - 1]})\n` +
    `  trade   buy open of E+1, sell close of E+${DECISIVE_HORIZON}; ${ROUND_TRIP_COST_PCT}% round-trip cost\n` +
    `  select  SUE >= ${SUE_THRESHOLD} on 10-Q quarters Q1-Q3, event = first 8-K item 2.02\n` +
    `  pool    raw price $${POOL.minPrice}-$${POOL.maxPrice}, prev $vol >= $${POOL.minDollarVolume}\n` +
    `  split   out-of-sample = reaction sessions before ${SEEN_FROM}`,
  );

  const universe = (await getDynamicUniverse()).filter(s => !isDerivativeSymbol(s));
  console.log(`  universe ${universe.length} symbols (derivatives excluded)`);

  const pool: PoolState = {
    baseline: new Map(),
    decisiveReturns: emptyRunningStats(),
    candidates: [],
    rows: 0,
  };
  const start = nyWallTimeToUtc(sessionDay(sessions[0]), 4, 0);
  const end = nyWallTimeToUtc(sessionDay(sessions[sessions.length - 1]), 16, 0);

  for (let c = 0; c < universe.length; c += SYMBOL_CHUNK) {
    const chunk = universe.slice(c, c + SYMBOL_CHUNK);
    const adjusted = await fetchBars(chunk, '1Day', start, end, FEED, 'split');
    const raw = await fetchBars(chunk, '1Day', start, end, FEED, 'raw');
    for (const [symbol, bars] of adjusted) {
      const rawBars = raw.get(symbol);
      if (rawBars !== undefined) scanPool(symbol, bars, rawBars, sessions, sessionOf, pool);
    }
    console.log(
      `  bars ${Math.min(c + SYMBOL_CHUNK, universe.length)}/${universe.length} symbols | ` +
      `pool rows ${pool.rows} | pool symbols ${pool.candidates.length}`,
    );
  }

  const client = createEdgarClient(config.policyMonitor.secUserAgent);
  const tickers = parseTickerMap(await client.tickerMap());
  const funnel = emptyFunnel();
  const hits = await collectHits(pool.candidates, { sessions, sessionOf, client, tickers }, funnel);

  report(hits, pool, funnel);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
