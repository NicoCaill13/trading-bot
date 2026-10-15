/**
 * Study: does cross-sectional momentum on liquid names beat the index net of
 * costs, on a time scale a cash account can trade with low turnover?
 *
 * Every earlier study (intraday selection, news direction, post-catalyst drift)
 * found no edge in what the bot sees at the open. This is the one family left
 * that has published evidence and does not depend on speed: at each monthly
 * rebalance, rank liquid names on their 12-1 month return, buy the top decile
 * (and the top 20 names, the size a small account could actually hold) at the
 * next open, sell 21 sessions later.
 *
 * Read-only research on daily bars. Nothing here touches the bot.
 *
 * Comparators, all over the same window:
 *   pool  = every eligible name, equal weight (does the rank add anything?)
 *   SPY   = index buy and hold (does the whole thing beat doing nothing?)
 * PASS needs both excess intervals above zero at the primary cost. Rebalances
 * do not overlap, so each one is an independent observation.
 *
 * Known limits: the universe is today's active assets, so names delisted after
 * a fall are missing and past winners look better than they were (survivorship
 * favours momentum); a name with no exit bar is dropped, not charged a loss;
 * full turnover is charged every month. A PASS here is necessary, not
 * sufficient: it would still need a forward shadow run before any order.
 *
 * Run: npx tsx scripts/studyMomentum.ts [sessions=1260]
 */

import { getDynamicUniverse } from '../src/screener';
import { nyWallTimeToUtc } from '../src/utils';
import { fetchBars, fetchRecentSessions, type Feed } from './lib/barFetch';
import type { SessionOf } from './lib/driftStudy';
import { isDerivativeSymbol, summarizeTrades, type TradeSample } from './lib/eligibleStudy';
import {
  FORMATION_SESSIONS,
  HOLD_SESSIONS,
  SKIP_SESSIONS,
  bottomCandidates,
  compoundedReturnPct,
  decileSize,
  holdReturnPct,
  indexBySession,
  meanReturnPct,
  momentumScorePct,
  passesLiquidity,
  rebalanceSessions,
  topCandidates,
  type BarsBySession,
  type Candidate,
  type LiquidityLimits,
} from './lib/momentumStudy';

const FEED: Feed = 'sip';
const SESSIONS = Number(process.argv[2] ?? 1260);
const BENCHMARK = 'SPY';

/** Pre-declared. Primary cost is large-cap realistic; the stress cost is the small-cap figure of the earlier studies. */
const PRIMARY_COST_PCT = 0.3;
const STRESS_COST_PCT = 1;
const TOP_N = 20;
const MIN_POOL_SIZE = 100;
const MIN_REBALANCES_FOR_GATE = 24;
const SESSIONS_PER_YEAR = 252;

const LIQUIDITY: LiquidityLimits = { minPrice: 10, minAverageDollarVolume: 20_000_000 };

/** Sessions fetched before the evaluation window so the first rank has its formation history. */
const HISTORY_SESSIONS = FORMATION_SESSIONS + 5;
const SYMBOL_CHUNK = 400;

const dateOf = (timestamp: string): string => timestamp.slice(0, 10);

function sessionDay(session: string): Date {
  const [year, month, day] = session.split('-').map(Number);
  return new Date(year, month - 1, day);
}

interface Rebalance {
  session: string;
  poolSize: number;
  pool: number;
  decile: number;
  topN: number;
  bottomDecile: number;
  spy: number;
}

/** Gross holding-period returns of each portfolio for one rebalance, or null when too thin. */
function evaluateRebalance(
  session: string,
  candidates: readonly Candidate[],
  spy: number,
): Rebalance | null {
  if (candidates.length < MIN_POOL_SIZE) return null;
  const size = decileSize(candidates.length);

  const pool = meanReturnPct(candidates);
  const decile = meanReturnPct(topCandidates(candidates, size));
  const topN = meanReturnPct(topCandidates(candidates, TOP_N));
  const bottomDecile = meanReturnPct(bottomCandidates(candidates, size));
  if (pool === null || decile === null || topN === null || bottomDecile === null) return null;

  return { session, poolSize: candidates.length, pool, decile, topN, bottomDecile, spy };
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

function collectSymbol(
  adjusted: BarsBySession,
  raw: BarsBySession,
  symbol: string,
  rebalances: readonly number[],
  poolBySession: Map<number, Candidate[]>,
): void {
  for (const session of rebalances) {
    if (!passesLiquidity(raw, session, LIQUIDITY)) continue;
    const scorePct = momentumScorePct(adjusted, session);
    const returnPct = holdReturnPct(adjusted, session, HOLD_SESSIONS);
    if (scorePct === null || returnPct === null) continue;

    const list = poolBySession.get(session);
    if (list === undefined) poolBySession.set(session, [{ symbol, scorePct, returnPct }]);
    else list.push({ symbol, scorePct, returnPct });
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const fmt = (value: number): string => value.toFixed(2).padStart(6);

type Pick = (rebalance: Rebalance) => number;

function samples(
  label: string,
  rows: readonly Rebalance[],
  value: (rebalance: Rebalance) => number,
): TradeSample[] {
  return rows.map(r => ({
    session: r.session,
    symbol: label,
    outcome: 'open' as const,
    netReturnPct: value(r),
  }));
}

function printPortfolio(
  label: string,
  rows: readonly Rebalance[],
  pick: Pick,
  costPct: number,
  gated: boolean,
): void {
  const net = summarizeTrades(samples(label, rows, r => pick(r) - costPct));
  const vsSpy = summarizeTrades(samples(label, rows, r => pick(r) - costPct - r.spy));
  const vsPool = summarizeTrades(samples(label, rows, r => pick(r) - r.pool));

  const gate = !gated
    ? 'diagnostic'
    : net.n < MIN_REBALANCES_FOR_GATE
      ? 'too few'
      : vsSpy.clusteredCi95LowPct > 0 && vsPool.clusteredCi95LowPct > 0 ? 'PASS' : 'fail';

  console.log(
    `  ${label.padEnd(12)} cost ${costPct.toFixed(1)}% n ${String(net.n).padStart(3)} ` +
    `net/mo ${fmt(net.meanNetPct)}% ` +
    `vs SPY ${fmt(vsSpy.meanNetPct)}% [${fmt(vsSpy.clusteredCi95LowPct)},${fmt(vsSpy.clusteredCi95HighPct)}] ` +
    `vs pool ${fmt(vsPool.meanNetPct)}% [${fmt(vsPool.clusteredCi95LowPct)},${fmt(vsPool.clusteredCi95HighPct)}]  ${gate}`,
  );
}

function annualisedPct(totalPct: number, rebalances: number): number {
  const years = (rebalances * HOLD_SESSIONS) / SESSIONS_PER_YEAR;
  return years > 0 ? ((1 + totalPct / 100) ** (1 / years) - 1) * 100 : 0;
}

function printGrowth(rows: readonly Rebalance[]): void {
  const lines: [string, number[]][] = [
    [`decile net ${PRIMARY_COST_PCT}%`, rows.map(r => r.decile - PRIMARY_COST_PCT)],
    [`top${TOP_N} net ${PRIMARY_COST_PCT}%`, rows.map(r => r.topN - PRIMARY_COST_PCT)],
    ['pool gross', rows.map(r => r.pool)],
    [BENCHMARK, rows.map(r => r.spy)],
  ];
  console.log('  compounded over the segment (total / per year):');
  for (const [label, returns] of lines) {
    const total = compoundedReturnPct(returns);
    console.log(
      `    ${label.padEnd(18)} ${fmt(total)}% / ${fmt(annualisedPct(total, returns.length))}%`,
    );
  }
}

function reportSegment(title: string, rows: readonly Rebalance[], growth: boolean): void {
  console.log(`\n${title}  (${rows.length} rebalances)`);
  if (rows.length === 0) return;

  printPortfolio('decile', rows, r => r.decile, PRIMARY_COST_PCT, true);
  printPortfolio('decile', rows, r => r.decile, STRESS_COST_PCT, true);
  printPortfolio(`top${TOP_N}`, rows, r => r.topN, PRIMARY_COST_PCT, true);
  printPortfolio(`top${TOP_N}`, rows, r => r.topN, STRESS_COST_PCT, true);
  printPortfolio('bottom decile', rows, r => r.bottomDecile, PRIMARY_COST_PCT, false);
  if (growth) printGrowth(rows);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const allSessions = await fetchRecentSessions(SESSIONS + HISTORY_SESSIONS);
  const sessionIndex = new Map(allSessions.map((date, i) => [date, i]));
  const sessionOf: SessionOf = timestamp => sessionIndex.get(dateOf(timestamp));
  const rebalances = rebalanceSessions(HISTORY_SESSIONS, allSessions.length - 1, HOLD_SESSIONS);

  console.log(
    `\nMomentum study — ${FEED.toUpperCase()}, ${rebalances.length} monthly rebalances ` +
    `(${allSessions[rebalances[0]]} .. ${allSessions[rebalances[rebalances.length - 1]]})\n` +
    `  rank    return from close -${FORMATION_SESSIONS} to close -${SKIP_SESSIONS} sessions (split-adjusted)\n` +
    `  trade   buy open of R+1, sell close of R+${HOLD_SESSIONS}; top decile and top ${TOP_N} names, equal weight\n` +
    `  pool    raw price >= $${LIQUIDITY.minPrice}, ${60}-session avg $vol >= ` +
    `$${LIQUIDITY.minAverageDollarVolume / 1_000_000}M, at least ${MIN_POOL_SIZE} names\n` +
    `  cost    ${PRIMARY_COST_PCT}% primary, ${STRESS_COST_PCT}% stress, full turnover every month`,
  );

  const universe = (await getDynamicUniverse()).filter(s => !isDerivativeSymbol(s));
  console.log(`  universe ${universe.length} symbols (derivatives and ETFs excluded)`);

  const start = nyWallTimeToUtc(sessionDay(allSessions[0]), 4, 0);
  const end = nyWallTimeToUtc(sessionDay(allSessions[allSessions.length - 1]), 16, 0);

  const benchmarkBars = (await fetchBars([BENCHMARK], '1Day', start, end, FEED, 'split')).get(BENCHMARK);
  if (benchmarkBars === undefined) throw new Error(`no ${BENCHMARK} bars`);
  const benchmark = indexBySession(benchmarkBars, sessionOf);

  const poolBySession = new Map<number, Candidate[]>();
  for (let c = 0; c < universe.length; c += SYMBOL_CHUNK) {
    const chunk = universe.slice(c, c + SYMBOL_CHUNK);
    const adjusted = await fetchBars(chunk, '1Day', start, end, FEED, 'split');
    const raw = await fetchBars(chunk, '1Day', start, end, FEED, 'raw');

    for (const [symbol, bars] of adjusted) {
      const rawBars = raw.get(symbol);
      if (rawBars === undefined) continue;
      collectSymbol(
        indexBySession(bars, sessionOf),
        indexBySession(rawBars, sessionOf),
        symbol,
        rebalances,
        poolBySession,
      );
    }
    console.log(`  ${Math.min(c + SYMBOL_CHUNK, universe.length)}/${universe.length} symbols`);
  }

  const results: Rebalance[] = [];
  for (const session of rebalances) {
    const spy = holdReturnPct(benchmark, session, HOLD_SESSIONS);
    if (spy === null) continue;
    const row = evaluateRebalance(allSessions[session], poolBySession.get(session) ?? [], spy);
    if (row !== null) results.push(row);
  }

  const sizes = results.map(r => r.poolSize);
  console.log(
    `\n  usable rebalances ${results.length}/${rebalances.length}, ` +
    `pool size ${Math.min(...sizes)}..${Math.max(...sizes)}`,
  );

  const middle = results[Math.floor(results.length / 2)]?.session ?? '';
  reportSegment('ALL REBALANCES', results, true);
  reportSegment(`FIRST HALF (before ${middle})`, results.filter(r => r.session < middle), false);
  reportSegment(`SECOND HALF (from ${middle})`, results.filter(r => r.session >= middle), false);

  console.log(
    `\nCaveats: universe = today's active assets (survivorship favours momentum); ` +
    `names with no exit bar are dropped; vs SPY mixes beta with selection, vs pool isolates the rank; ` +
    `PASS needs n >= ${MIN_REBALANCES_FOR_GATE} and both excess CIs above 0 (primary cost ${PRIMARY_COST_PCT}%).\n`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
