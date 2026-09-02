/**
 * Opening-range selection — pure, no I/O.
 *
 * The live stream and the REST backfill must agree on which 1-min bar is the
 * session open. Capturing "the first bar we happened to receive after 09:30"
 * is wrong: a name added at 09:35 would treat 09:35 as the opening range.
 */

import { minutesSinceMidnight, toESTDate } from './utils';
import type { BarData } from './types';

export interface OpeningRangeSelection {
  sessionOpen: number;
  rangeBar: BarData;
}

export function barMinutesSinceMidnight(timestamp: string): number {
  return minutesSinceMidnight(toESTDate(new Date(timestamp)));
}

/**
 * First regular-session 1-min bar: timestamped at or after `marketOpenMinutes`
 * with a usable open. Premarket bars in `bars` are ignored.
 */
export function selectOpeningRangeBar(
  bars: readonly BarData[],
  marketOpenMinutes: number,
): OpeningRangeSelection | null {
  for (const bar of bars) {
    if (!(bar.open > 0)) continue;
    if (barMinutesSinceMidnight(bar.timestamp) < marketOpenMinutes) continue;
    return { sessionOpen: bar.open, rangeBar: bar };
  }
  return null;
}

/**
 * Running RTH high from the 09:30 bar onward (inclusive). Premarket bars
 * before `rangeBar` are ignored. Null when no positive high exists.
 *
 * Scanner-hold FOMO uses this, not `rangeBar.high`: a quiet 09:30 print
 * (ASTS/CDE 02/09) is not the wick — the 09:31–09:33 drive is.
 */
export function computeSessionImpulseHigh(
  bars: readonly BarData[],
  rangeBar: BarData,
): number | null {
  let high = rangeBar.high > 0 ? rangeBar.high : 0;
  for (const bar of bars) {
    if (bar.timestamp < rangeBar.timestamp) continue;
    if (bar.high > high) high = bar.high;
  }
  return high > 0 ? high : null;
}
