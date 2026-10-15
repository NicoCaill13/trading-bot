/**
 * Study: which names pay +TARGET% from a realistic 09:35 entry, can anything
 * known before the open pick them, and does a rule keep a positive expectancy
 * on sessions it was never tuned on.
 *
 * Read-only research. Nothing here touches the bot or its journal.
 *
 * Pool     : names passing the live price band and previous-session dollar
 *            volume, minus warrants / rights / units.
 * Trade    : enter at the 09:34 bar close, exit at +TARGET, at -STOP, or at the
 *            15:55 close. A bar touching both levels counts as stopped.
 * Features : previous-session data only, plus the session open as a proxy for
 *            the pre-market gap. Opening confirmation uses bars up to 09:34.
 * Split    : sessions before SEEN_FROM were never looked at when the rules were
 *            written; sessions from SEEN_FROM on were. Only the first group is a
 *            valid out-of-sample test.
 *
 * Minute bars are fetched for names whose daily range can contain the target,
 * for names a rule selects, and for a stride sample of the pool (the baseline).
 * Per-session results are cached, so editing rules or reports re-runs for free.
 *
 * Known limits: the universe is today's active assets (delisted names are
 * absent), fills are idealised, and every rule variant is another comparison.
 *
 * Run: npx tsx scripts/studyEligibleMovers.ts [sessions=250] [targetPct=10] [stopPct=3]
 */

import config from '../src/config';
import { getDynamicUniverse } from '../src/screener';
import { nyWallTimeToUtc } from '../src/utils';
import { fetchBars, fetchRecentSessions, type Feed, type RawBar } from './lib/barFetch';
import { barMinutes } from './lib/scannerReplay';
import {
  FEATURE_LOOKBACK,
  STUDY_RULES,
  bucketPrecision,
  computeOpeningConfirm,
  computePreOpenFeatures,
  isDerivativeSymbol,
  simulateIntraday,
  summarizeTrades,
  type BucketRow,
  type PreOpenFeatures,
} from './lib/eligibleStudy';
import {
  STUDY_CACHE_VERSION,
  loadCachedRows,
  saveCachedRows,
  studyCacheDir,
  type StudyRow,
} from './lib/studyCache';
import { formatPct as pct, formatTradeLine, toTradeSamples } from './lib/studyReport';

const FEED: Feed = 'sip';
const SESSIONS = Number(process.argv[2] ?? 250);
const TARGET_PCT = Number(process.argv[3] ?? 10);
const STOP_PCT = Number(process.argv[4] ?? 3);
/** Round-trip cost charged on every simulated trade, in percent. */
const ROUND_TRIP_COST_PCT = 1;

/** First session whose results were read before the rules were written. */
const SEEN_FROM = '2026-08-19';
/** Minimum trades before a rule can be called validated. */
const MIN_TRADES_FOR_GATE = 30;

const OPEN_MINUTE = 9 * 60 + 30;
const ENTRY_MINUTE = 9 * 60 + 34;
const END_MINUTE = 15 * 60 + 55;
const HISTORY_CALENDAR_DAYS = 45;
const BASELINE_PER_SESSION = 30;
const MS_PER_DAY = 86_400_000;

const CACHE_DIR = studyCacheDir(TARGET_PCT, STOP_PCT);

interface FeatureSpec {
  name: string;
  value: (row: StudyRow) => number;
  edges: readonly number[];
}

const FEATURES: readonly FeatureSpec[] = [
  { name: 'gap % (open vs prev close)', value: r => r.gapPct, edges: [-2, 0, 2, 4, 8, 15] },
  { name: 'prev session return %', value: r => r.prevReturnPct, edges: [-3, 0, 3, 8] },
  { name: 'ATR 20d % of price', value: r => r.atrPct20, edges: [2, 4, 6, 8] },
  { name: 'prev $vol / 20d avg', value: r => r.dollarVolumeRatio, edges: [0.5, 1, 2, 4] },
  { name: 'distance below 20d high %', value: r => r.distanceFromHighPct, edges: [2, 5, 10, 20] },
  { name: 'prev close location (0-1)', value: r => r.prevCloseLocation, edges: [0.3, 0.6, 0.8] },
  { name: 'prev close price $', value: r => r.prevClose, edges: [5, 10, 20, 40] },
];

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function sessionDay(session: string): Date {
  const [year, month, day] = session.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function printBuckets(title: string, rows: readonly BucketRow[]): void {
  console.log(`\n  ${title}`);
  for (const b of rows) {
    console.log(
      `    ${b.label.padEnd(12)} n=${String(b.n).padStart(6)} ` +
      `hits=${String(b.hits).padStart(4)} ` +
      `precision=${pct(b.precision).padStart(6)} lift=${b.lift.toFixed(2)}x`,
    );
  }
}

// ---------------------------------------------------------------------------
// One session
// ---------------------------------------------------------------------------

function indexByDate(
  daily: ReadonlyMap<string, readonly RawBar[]>,
): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const [symbol, bars] of daily) {
    const byDate = new Map<string, number>();
    bars.forEach((bar, i) => byDate.set(bar.t.slice(0, 10), i));
    out.set(symbol, byDate);
  }
  return out;
}

interface PoolEntry {
  symbol: string;
  features: PreOpenFeatures;
  wideRange: boolean;
}

function buildPool(
  session: string,
  universe: readonly string[],
  daily: ReadonlyMap<string, readonly RawBar[]>,
  dateIndex: ReadonlyMap<string, ReadonlyMap<string, number>>,
): PoolEntry[] {
  const pool: PoolEntry[] = [];

  for (const symbol of universe) {
    const bars = daily.get(symbol);
    const idx = dateIndex.get(symbol)?.get(session);
    if (bars === undefined || idx === undefined || idx <= 0) continue;

    const history = bars.slice(Math.max(0, idx - FEATURE_LOOKBACK - 1), idx);
    const features = computePreOpenFeatures(history, bars[idx].o);
    if (features === null) continue;
    if (features.prevClose < config.screener.minClosePrice) continue;
    if (features.prevClose > config.screener.maxClosePrice) continue;
    if (features.prevDollarVolume < config.premarket.poolMinPrevDollarVolume) continue;

    const today = bars[idx];
    const wideRange = today.l > 0 && ((today.h - today.l) / today.l) * 100 >= TARGET_PCT;
    pool.push({ symbol, features, wideRange });
  }

  // Sorted so the stride sample below is reproducible.
  return pool.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

async function studySession(
  session: string,
  universe: readonly string[],
  daily: ReadonlyMap<string, readonly RawBar[]>,
  dateIndex: ReadonlyMap<string, ReadonlyMap<string, number>>,
): Promise<StudyRow[]> {
  const pool = buildPool(session, universe, daily, dateIndex);
  const day = sessionDay(session);

  const stride = Math.max(1, Math.floor(pool.length / BASELINE_PER_SESSION));
  const offset = Math.floor(Date.parse(session) / MS_PER_DAY) % stride;

  const planned = pool.map((entry, i) => {
    const inBaseline = i % stride === offset;
    const selectedByRule = STUDY_RULES.some(rule => rule.selects(entry.features));
    return { ...entry, inBaseline, attempted: entry.wideRange || inBaseline || selectedByRule };
  });

  const toFetch = planned.filter(p => p.attempted).map(p => p.symbol);
  const oneMin = toFetch.length > 0
    ? await fetchBars(toFetch, '1Min', nyWallTimeToUtc(day, 9, 30), nyWallTimeToUtc(day, 16, 0), FEED)
    : new Map<string, RawBar[]>();

  return planned.map((p): StudyRow => {
    const bars = oneMin.get(p.symbol) ?? [];
    const result = p.attempted
      ? simulateIntraday(bars, {
        entryMinute: ENTRY_MINUTE,
        endMinute: END_MINUTE,
        targetPct: TARGET_PCT,
        stopPct: STOP_PCT,
        minutesOf: barMinutes,
      })
      : null;
    const confirm = p.attempted
      ? computeOpeningConfirm(bars, {
        openMinute: OPEN_MINUTE,
        entryMinute: ENTRY_MINUTE,
        minutesOf: barMinutes,
      })
      : null;

    return {
      ...p.features,
      session,
      symbol: p.symbol,
      inBaseline: p.inBaseline,
      attempted: p.attempted,
      sim: result === null
        ? null
        : {
          outcome: result.outcome,
          returnPct: result.returnPct,
          maxFavourablePct: result.maxFavourablePct,
        },
      confirm,
    };
  });
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const isConfirmed = (row: StudyRow): boolean =>
  row.confirm !== null && row.confirm.aboveVwap && row.confirm.fromOpenPct >= 0;

function printRuleLine(
  name: string,
  selected: readonly StudyRow[],
  sessionCount: number,
): void {
  const stats = summarizeTrades(toTradeSamples(selected, ROUND_TRIP_COST_PCT));
  console.log(
    formatTradeLine(name, selected.length, stats, sessionCount, STOP_PCT, MIN_TRADES_FOR_GATE),
  );
}

function reportSegment(title: string, rows: readonly StudyRow[]): void {
  const sessions = new Set(rows.map(r => r.session));
  const hits = rows.filter(r => r.sim?.outcome === 'target').length;
  const unfillable = rows.filter(r => r.attempted && r.sim === null).length;

  console.log(
    `\n${title} — ${sessions.size} sessions, ${rows.length} pool rows\n` +
    `  hits ${hits} (${pct(rows.length > 0 ? hits / rows.length : 0)} of pool, ` +
    `${(hits / Math.max(1, sessions.size)).toFixed(1)} per session) | ` +
    `no print at 09:34: ${unfillable}`,
  );
  if (rows.length === 0) return;

  console.log(
    `  net = gross - ${ROUND_TRIP_COST_PCT}% cost | R = net / ${STOP_PCT}% stop | ` +
    `gate: >= ${MIN_TRADES_FOR_GATE} trades and day-clustered 95% CI low > 0`,
  );
  printRuleLine('baseline (pool stride sample)', rows.filter(r => r.inBaseline), sessions.size);

  for (const rule of STUDY_RULES) {
    const selected = rows.filter(r => rule.selects(r));
    printRuleLine(rule.name, selected, sessions.size);
    printRuleLine(`${rule.name} +confirm`, selected.filter(isConfirmed), sessions.size);
  }
}

function reportFeatureTables(title: string, rows: readonly StudyRow[]): void {
  if (rows.length === 0) return;
  const hits = rows.filter(r => r.sim?.outcome === 'target').length;
  const baseRate = hits / rows.length;
  console.log(`\nPRECISION BY PRE-OPEN FEATURE — ${title} (base ${pct(baseRate)})`);
  for (const f of FEATURES) {
    printBuckets(
      f.name,
      bucketPrecision(rows, f.value, r => r.sim?.outcome === 'target', f.edges, baseRate),
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function computeMissing(
  missing: readonly string[],
  bySession: Map<string, StudyRow[]>,
): Promise<void> {
  const universe = (await getDynamicUniverse()).filter(s => !isDerivativeSymbol(s));
  const firstDay = sessionDay(missing[0]);
  const lastDay = sessionDay(missing[missing.length - 1]);
  const dailyStart = new Date(
    nyWallTimeToUtc(firstDay, 4, 0).getTime() - HISTORY_CALENDAR_DAYS * MS_PER_DAY,
  );

  console.log(`  universe ${universe.length} symbols (derivatives excluded)`);
  console.log(`  fetching 1Day ${FEED} history for ${missing.length} uncached sessions...`);
  const daily = await fetchBars(universe, '1Day', dailyStart, nyWallTimeToUtc(lastDay, 16, 0), FEED);
  const dateIndex = indexByDate(daily);

  for (const session of missing) {
    const rows = await studySession(session, universe, daily, dateIndex);
    await saveCachedRows(CACHE_DIR, session, rows);
    bySession.set(session, rows);
    const hits = rows.filter(r => r.sim?.outcome === 'target').length;
    console.log(`  ${session} pool ${String(rows.length).padStart(5)} hits ${String(hits).padStart(3)}`);
  }
}

async function main(): Promise<void> {
  const sessions = await fetchRecentSessions(SESSIONS);

  console.log(
    `\nEligible mover study ${STUDY_CACHE_VERSION} — ${FEED.toUpperCase()}, ${sessions.length} sessions ` +
    `(${sessions[0]} .. ${sessions[sessions.length - 1]})\n` +
    `  trade   enter 09:34 close, +${TARGET_PCT}% target, -${STOP_PCT}% stop, flat 15:55, ` +
    `${ROUND_TRIP_COST_PCT}% round-trip cost\n` +
    `  pool    price $${config.screener.minClosePrice}-$${config.screener.maxClosePrice}, ` +
    `prev $vol >= $${config.premarket.poolMinPrevDollarVolume}\n` +
    `  split   out-of-sample = sessions before ${SEEN_FROM}`,
  );

  const bySession = new Map<string, StudyRow[]>();
  const missing: string[] = [];
  for (const session of sessions) {
    const cached = await loadCachedRows(CACHE_DIR, session);
    if (cached === null) missing.push(session);
    else bySession.set(session, cached);
  }
  console.log(`  cache   ${bySession.size} sessions loaded, ${missing.length} to compute`);

  if (missing.length > 0) await computeMissing(missing, bySession);

  const all = sessions.flatMap(s => bySession.get(s) ?? []);
  const outOfSample = all.filter(r => r.session < SEEN_FROM);
  const seen = all.filter(r => r.session >= SEEN_FROM);

  reportSegment('OUT-OF-SAMPLE (rules never tuned here)', outOfSample);
  reportSegment('SEEN (rules written after reading this)', seen);
  reportFeatureTables(outOfSample.length > 0 ? 'out-of-sample' : 'all sessions',
    outOfSample.length > 0 ? outOfSample : all);

  console.log(
    `\nCaveats: universe = today's active assets (survivorship); fills at the 09:34 close ` +
    `with no slippage beyond the flat cost; ${STUDY_RULES.length * 2 + 1} rule variants compared.\n`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
