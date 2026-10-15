/**
 * Study: does a bullish pre-open headline add the direction that volatility
 * features lack?
 *
 * The first study showed gap / ATR / volume rules multiply +10% touches and -3%
 * stops in equal measure: they pick movement, not direction. News is the one
 * candidate that could carry direction, and it was never measured at scale.
 *
 * Read-only research. Reuses the minute-bar simulation cached by
 * studyEligibleMovers (same sessions, target and stop), then labels each
 * simulated name by what the bot's own strict news gate would have said at the
 * entry minute: bullish and no bearish headline in the same lookback the live
 * bot uses.
 *
 * Every session is valid out-of-sample for this variable: no news result had
 * been read when it was written. The rules are the ones already fixed.
 *
 * Run (after studyEligibleMovers with the same arguments):
 *   npx tsx scripts/studyNewsDirection.ts [sessions=500] [targetPct=10] [stopPct=3]
 */

import config from '../src/config';
import { readJson, writeJsonAtomic } from '../src/jsonStore';
import { nyWallTimeToUtc } from '../src/utils';
import { fetchRecentSessions } from './lib/barFetch';
import { STUDY_RULES, summarizeTrades } from './lib/eligibleStudy';
import {
  classifyNews,
  fetchNewsWindow,
  groupBySymbol,
  type NewsClass,
} from './lib/eligibleNews';
import { loadCachedRows, studyCacheDir, type StudyRow } from './lib/studyCache';
import { formatPct, formatTradeLine, toTradeSamples } from './lib/studyReport';

const SESSIONS = Number(process.argv[2] ?? 500);
const TARGET_PCT = Number(process.argv[3] ?? 10);
const STOP_PCT = Number(process.argv[4] ?? 3);
const ROUND_TRIP_COST_PCT = 1;
const MIN_TRADES_FOR_GATE = 30;

/** Same minute the minute-bar simulation enters at. */
const ENTRY_HOUR = 9;
const ENTRY_MINUTE_OF_HOUR = 34;
const MS_PER_HOUR = 3_600_000;

const NEWS_CACHE_VERSION = 'v1';
const NEWS_LOOKBACK_HOURS = config.sentiment.lookbackHours;
const NEWS_CACHE_DIR = `./data/study_eligible/news_${NEWS_CACHE_VERSION}_h${NEWS_LOOKBACK_HOURS}`;

interface NewsRow extends StudyRow {
  news: NewsClass;
}

interface NewsCacheEntry {
  truncated: boolean;
  classes: Record<string, NewsClass>;
}

function isNewsCacheEntry(value: unknown): value is NewsCacheEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as { truncated?: unknown; classes?: unknown };
  return (
    typeof entry.truncated === 'boolean' &&
    typeof entry.classes === 'object' &&
    entry.classes !== null
  );
}

function sessionDay(session: string): Date {
  const [year, month, day] = session.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/** Simulated names the study can score: rule-selected or in the baseline sample. */
function isStudied(row: StudyRow): boolean {
  return row.sim !== null && (row.inBaseline || STUDY_RULES.some(rule => rule.selects(row)));
}

async function loadNewsClasses(
  session: string,
  symbols: readonly string[],
): Promise<NewsCacheEntry> {
  const cached = await readJson(`${NEWS_CACHE_DIR}/${session}.json`);
  if (isNewsCacheEntry(cached)) return cached;

  const end = nyWallTimeToUtc(sessionDay(session), ENTRY_HOUR, ENTRY_MINUTE_OF_HOUR);
  const start = new Date(end.getTime() - NEWS_LOOKBACK_HOURS * MS_PER_HOUR);
  const { headlines, truncated } = await fetchNewsWindow(symbols, start, end);
  const bySymbol = groupBySymbol(headlines, symbols);

  const classes: Record<string, NewsClass> = {};
  for (const symbol of symbols) classes[symbol] = classifyNews(bySymbol.get(symbol) ?? []);

  const entry: NewsCacheEntry = { truncated, classes };
  await writeJsonAtomic(`${NEWS_CACHE_DIR}/${session}.json`, entry);
  return entry;
}

function printLine(name: string, rows: readonly NewsRow[], sessionCount: number): void {
  const stats = summarizeTrades(toTradeSamples(rows, ROUND_TRIP_COST_PCT));
  console.log(
    formatTradeLine(name, rows.length, stats, sessionCount, STOP_PCT, MIN_TRADES_FOR_GATE),
  );
}

function reportSegment(title: string, rows: readonly NewsRow[]): void {
  const sessionCount = new Set(rows.map(r => r.session)).size;
  const share = (cls: NewsClass): string =>
    formatPct(rows.length > 0 ? rows.filter(r => r.news === cls).length / rows.length : 0);

  console.log(
    `\n${title} — ${sessionCount} sessions, ${rows.length} simulated names\n` +
    `  news mix: bullish ${share('bullish')} | other ${share('other')} | none ${share('none')}`,
  );
  if (rows.length === 0) return;

  const baseline = rows.filter(r => r.inBaseline);
  printLine('baseline', baseline, sessionCount);
  for (const cls of ['bullish', 'other', 'none'] as const) {
    printLine(`baseline & news=${cls}`, baseline.filter(r => r.news === cls), sessionCount);
  }

  for (const rule of STUDY_RULES) {
    const selected = rows.filter(r => rule.selects(r));
    printLine(rule.name, selected, sessionCount);
    printLine(`${rule.name} & bullish`, selected.filter(r => r.news === 'bullish'), sessionCount);
    printLine(`${rule.name} & not bullish`, selected.filter(r => r.news !== 'bullish'), sessionCount);
  }
}

async function main(): Promise<void> {
  const sessions = await fetchRecentSessions(SESSIONS);
  const dir = studyCacheDir(TARGET_PCT, STOP_PCT);

  console.log(
    `\nNews direction study — ${sessions.length} sessions ` +
    `(${sessions[0]} .. ${sessions[sessions.length - 1]})\n` +
    `  trade   same simulation as studyEligibleMovers (+${TARGET_PCT}% / -${STOP_PCT}%, ` +
    `${ROUND_TRIP_COST_PCT}% cost)\n` +
    `  news    strict gate (bullish, no bearish), ${NEWS_LOOKBACK_HOURS}h lookback ending 09:34`,
  );

  const all: NewsRow[] = [];
  const truncatedSessions: string[] = [];
  const missingSessions: string[] = [];

  for (const session of sessions) {
    const rows = await loadCachedRows(dir, session);
    if (rows === null) {
      missingSessions.push(session);
      continue;
    }

    const studied = rows.filter(isStudied);
    if (studied.length === 0) continue;

    const symbols = [...new Set(studied.map(r => r.symbol))];
    const { truncated, classes } = await loadNewsClasses(session, symbols);
    if (truncated) truncatedSessions.push(session);
    for (const row of studied) all.push({ ...row, news: classes[row.symbol] ?? 'none' });
  }

  if (missingSessions.length > 0) {
    throw new Error(
      `${missingSessions.length} session(s) missing from ${dir} — ` +
      `run studyEligibleMovers ${SESSIONS} ${TARGET_PCT} ${STOP_PCT} first`,
    );
  }

  const middle = sessions[Math.floor(sessions.length / 2)];
  reportSegment('ALL SESSIONS', all);
  reportSegment(`FIRST HALF (before ${middle})`, all.filter(r => r.session < middle));
  reportSegment(`SECOND HALF (from ${middle})`, all.filter(r => r.session >= middle));

  console.log(
    `\nTruncated news windows: ${truncatedSessions.length}` +
    `${truncatedSessions.length > 0 ? ` (${truncatedSessions.slice(0, 5).join(', ')}...)` : ''}\n` +
    `Caveats: news = lexicon headlines tagged to the symbol, no bearish word allowed; ` +
    `${3 + STUDY_RULES.length * 2} new comparisons per segment; day-clustered CI.\n`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
