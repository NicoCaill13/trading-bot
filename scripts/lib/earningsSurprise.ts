/**
 * Pure maths for the earnings-surprise study: how large was the earnings
 * change, which session reacted, and how a name compares with the same week's
 * other earnings events.
 *
 * Pre-declared in prereg-earnings-surprise.md. No I/O and no timezone handling:
 * the caller injects dates and minutes, so every rule is testable.
 */

const DAY_MS = 86_400_000;
const YEAR_DAYS = 365;

/** A diluted EPS fact as EDGAR reports it, already narrowed by the caller. */
export interface EpsFact {
  start: string;
  end: string;
  val: number;
  filed: string;
  form: string;
}

export interface QuarterEps {
  /** Period end, YYYY-MM-DD. */
  end: string;
  /** Date of the first filing that carried this period. */
  filed: string;
  eps: number;
}

export interface SueReading {
  sue: number;
  delta: number;
  sigma: number;
  priorDeltaCount: number;
}

/** Fixed before the run: editing any of these after reading results turns the test into a fit. */
export const SUE_THRESHOLD = 2;
export const QUARTER_MIN_DAYS = 80;
export const QUARTER_MAX_DAYS = 100;
export const PRIOR_YEAR_TOLERANCE_DAYS = 20;
export const SIGMA_LOOKBACK_DAYS = 1100;
export const MIN_PRIOR_DELTAS = 6;
export const MARKET_CLOSE_MINUTES = 16 * 60;

const dayNumber = (date: string): number => Date.parse(`${date}T00:00:00Z`) / DAY_MS;

export const daysBetween = (from: string, to: string): number =>
  Math.round(dayNumber(to) - dayNumber(from));

/**
 * Three-month diluted EPS from 10-Q filings, one per period end, ascending.
 * Year-to-date and annual facts are dropped by duration; a restatement in a
 * later filing never replaces the first value, which is what was knowable.
 */
export function parseQuarterlyEps(facts: readonly EpsFact[]): QuarterEps[] {
  const earliest = new Map<string, QuarterEps>();
  for (const fact of facts) {
    if (fact.form !== '10-Q' || !Number.isFinite(fact.val)) continue;
    const span = daysBetween(fact.start, fact.end);
    if (span < QUARTER_MIN_DAYS || span > QUARTER_MAX_DAYS) continue;
    const known = earliest.get(fact.end);
    if (known === undefined || fact.filed < known.filed) {
      earliest.set(fact.end, { end: fact.end, filed: fact.filed, eps: fact.val });
    }
  }
  return [...earliest.values()].sort((a, b) => a.end.localeCompare(b.end));
}

/** EPS change against the same quarter a year earlier, or null when that quarter is missing. */
function seasonalDelta(series: readonly QuarterEps[], i: number): number | null {
  const current = series[i];
  for (let j = i - 1; j >= 0; j--) {
    const gap = daysBetween(series[j].end, current.end);
    if (gap > YEAR_DAYS + PRIOR_YEAR_TOLERANCE_DAYS) return null;
    if (Math.abs(gap - YEAR_DAYS) <= PRIOR_YEAR_TOLERANCE_DAYS) {
      return current.eps - series[j].eps;
    }
  }
  return null;
}

function sampleStdDev(values: readonly number[]): number {
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const squares = values.reduce((sum, v) => sum + (v - mean) ** 2, 0);
  return Math.sqrt(squares / (values.length - 1));
}

/**
 * Standardised unexpected earnings of quarter `i` on a seasonal random walk.
 * Null when the year-ago quarter is missing, fewer than MIN_PRIOR_DELTAS earlier
 * changes exist in the lookback, or the history has no dispersion.
 */
export function computeSue(series: readonly QuarterEps[], i: number): SueReading | null {
  const current = series[i];
  if (current === undefined) return null;

  const delta = seasonalDelta(series, i);
  if (delta === null) return null;

  const prior: number[] = [];
  for (let k = i - 1; k >= 0; k--) {
    if (daysBetween(series[k].end, current.end) > SIGMA_LOOKBACK_DAYS) break;
    const change = seasonalDelta(series, k);
    if (change !== null) prior.push(change);
  }
  if (prior.length < MIN_PRIOR_DELTAS) return null;

  const sigma = sampleStdDev(prior);
  if (!(sigma > 0)) return null;

  return { sue: delta / sigma, delta, sigma, priorDeltaCount: prior.length };
}

/**
 * Index of the session that reacted to a release accepted at `acceptedDate`
 * (YYYY-MM-DD, New York) and `acceptedMinutes` after midnight. A release before
 * the close of a trading day reacts that day; anything later, or on a non-trading
 * day, reacts at the next session. `sessions` is ascending. Null past the calendar.
 */
export function reactionSessionIndex(
  sessions: readonly string[],
  acceptedDate: string,
  acceptedMinutes: number,
): number | null {
  const sameDay = sessions.indexOf(acceptedDate);
  if (sameDay !== -1 && acceptedMinutes < MARKET_CLOSE_MINUTES) return sameDay;
  const next = sessions.findIndex(session => session > acceptedDate);
  return next === -1 ? null : next;
}

/** ISO 8601 week of a YYYY-MM-DD date, as "YYYY-Www". */
export function isoWeekOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const weekday = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export interface EarningsEvent {
  symbol: string;
  /** Reaction session, YYYY-MM-DD. */
  session: string;
  sue: number;
  /** Forward return at the study horizon, in percent. */
  returnPct: number;
}

export interface ExcessSample {
  symbol: string;
  session: string;
  excessPct: number;
}

/**
 * Return of every selected event (SUE >= threshold) minus the mean return of the
 * non-selected events whose reaction session falls in the same ISO week. A
 * selected event with no such baseline is dropped and counted.
 */
export function excessVsWeekBaseline(
  events: readonly EarningsEvent[],
  threshold: number,
): { samples: ExcessSample[]; droppedNoBaseline: number } {
  const baseline = new Map<string, { sum: number; count: number }>();
  for (const event of events) {
    if (event.sue >= threshold) continue;
    const week = isoWeekOf(event.session);
    const entry = baseline.get(week) ?? { sum: 0, count: 0 };
    entry.sum += event.returnPct;
    entry.count += 1;
    baseline.set(week, entry);
  }

  const samples: ExcessSample[] = [];
  let droppedNoBaseline = 0;
  for (const event of events) {
    if (event.sue < threshold) continue;
    const entry = baseline.get(isoWeekOf(event.session));
    if (entry === undefined) {
      droppedNoBaseline += 1;
      continue;
    }
    samples.push({
      symbol: event.symbol,
      session: event.session,
      excessPct: event.returnPct - entry.sum / entry.count,
    });
  }
  return { samples, droppedNoBaseline };
}
