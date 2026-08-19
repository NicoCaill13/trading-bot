/**
 * Watchlist calendar freshness — pure.
 *
 * A file on disk is not a valid list for session D. The list is current only
 * when it was screened from the last required EOD close. Age in hours is a
 * legacy fallback for heartbeats that predate these fields.
 */

export interface RequiredWatchlistDayInput {
  /** YYYY-MM-DD in America/New_York. */
  todayNy: string;
  todayIsTrading: boolean;
  minutesSinceMidnight: number;
  /** Minutes since midnight of the post-close screener (20:00 → 1200). */
  screenerMinutes: number;
  /** Last Alpaca trading day strictly before `todayNy`. */
  previousTradingDay: string | null;
}

/**
 * Before the EOD screener of a trading day, the required list is the previous
 * session's close. From screener time onward on a trading day, it is today.
 * Weekends and holidays keep the previous session.
 */
export function resolveRequiredWatchlistTradingDay(
  input: RequiredWatchlistDayInput,
): string | null {
  if (input.todayIsTrading && input.minutesSinceMidnight >= input.screenerMinutes) {
    return input.todayNy;
  }
  return input.previousTradingDay;
}

export function isWatchlistCurrent(
  watchlist: { tradingDay?: string; symbols: readonly unknown[] } | null,
  requiredTradingDay: string | null,
): boolean {
  if (watchlist === null || watchlist.symbols.length === 0) return false;
  if (requiredTradingDay === null) return false;
  if (typeof watchlist.tradingDay !== 'string' || watchlist.tradingDay.length === 0) {
    return false;
  }
  return watchlist.tradingDay === requiredTradingDay;
}
