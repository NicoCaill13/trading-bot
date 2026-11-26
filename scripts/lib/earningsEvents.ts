/**
 * Turns a quarter's 10-Q into a dated market event: which 8-K press release
 * carried the news, when it was accepted in New York time, which session reacted,
 * and how many sessions later the 10-Q (the source of the XBRL EPS) came out.
 */

import { estCalendarDayKey, minutesSinceMidnight, toESTDate } from '../../src/utils';
import { reactionSessionIndex, type QuarterEps } from './earningsSurprise';
import type { Filing } from './edgarParse';

const EARNINGS_ITEM = '2.02';

export interface NyMoment {
  /** YYYY-MM-DD, New York. */
  date: string;
  minutes: number;
}

export interface ReleaseTiming {
  /** Index in the session calendar of the session that reacted to the release. */
  reactionIndex: number;
  /** Sessions between the release day and the 10-Q filing day. */
  gapSessions: number;
}

/** New York calendar day and minutes since midnight of an ISO instant, or null if unparseable. */
export function newYorkMoment(isoInstant: string): NyMoment | null {
  const instant = new Date(isoInstant);
  if (Number.isNaN(instant.getTime())) return null;
  const est = toESTDate(instant);
  return { date: estCalendarDayKey(est), minutes: minutesSinceMidnight(est) };
}

/**
 * First 8-K item 2.02 (results press release) filed between the quarter end and
 * the 10-Q, or null when none is datable.
 */
export function findEarningsRelease(quarter: QuarterEps, filings: readonly Filing[]): Filing | null {
  let first: Filing | null = null;
  for (const filing of filings) {
    if (filing.form !== '8-K') continue;
    if (!filing.items.split(',').map(item => item.trim()).includes(EARNINGS_ITEM)) continue;
    if (filing.filed < quarter.end || filing.filed > quarter.filed) continue;
    if (first === null || filing.acceptedAt < first.acceptedAt) first = filing;
  }
  return first;
}

/**
 * Reaction session and 10-Q delay for a release. Null when the release falls
 * before the calendar starts (it would be mistaken for the first session) or the
 * 10-Q is past the calendar's end.
 */
export function timeRelease(
  sessions: readonly string[],
  release: Filing,
  quarter: QuarterEps,
): ReleaseTiming | null {
  const moment = newYorkMoment(release.acceptedAt);
  if (moment === null || sessions.length === 0 || moment.date < sessions[0]) return null;

  const reactionIndex = reactionSessionIndex(sessions, moment.date, moment.minutes);
  const releaseDay = reactionSessionIndex(sessions, moment.date, 0);
  const filingDay = reactionSessionIndex(sessions, quarter.filed, 0);
  if (reactionIndex === null || releaseDay === null || filingDay === null) return null;

  return { reactionIndex, gapSessions: filingDay - releaseDay };
}
