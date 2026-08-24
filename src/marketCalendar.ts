import alpaca from './alpacaClient';
import config from './config';
import { createLogger } from './logger';
import { getESTDate, minutesSinceMidnight, toErrorMessage } from './utils';
import { resolveRequiredWatchlistTradingDay } from './watchlistFreshness';

const log = createLogger('CALENDAR');

export interface TradingCalendarDay {
  date: string;
  open: string;
  close: string;
}

function formatEstDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Returns the Alpaca calendar entry for the given EST date, or null when the market is closed.
 */
export async function getTradingDay(date = getESTDate()): Promise<TradingCalendarDay | null> {
  const dateStr = formatEstDate(date);

  try {
    const entries = await alpaca.getCalendar({ start: dateStr, end: dateStr }) as TradingCalendarDay[];
    if (!Array.isArray(entries) || entries.length === 0) return null;
    return entries[0] ?? null;
  } catch (err) {
    log.warn(`Calendar lookup failed for ${dateStr}: ${toErrorMessage(err)}`);
    return null;
  }
}

export async function isTradingDay(date = getESTDate()): Promise<boolean> {
  const entry = await getTradingDay(date);
  return entry !== null;
}

const PREVIOUS_DAY_LOOKBACK_DAYS = 14;

/**
 * Last Alpaca session strictly before `date` (NY wall-clock). Null when the
 * calendar is unreachable — callers must fail closed rather than guess today.
 */
export async function getPreviousTradingDay(date = getESTDate()): Promise<string | null> {
  const endStr = formatEstDate(date);
  const start = new Date(date.getTime());
  start.setDate(start.getDate() - PREVIOUS_DAY_LOOKBACK_DAYS);
  const startStr = formatEstDate(start);

  try {
    const entries = await alpaca.getCalendar({ start: startStr, end: endStr }) as TradingCalendarDay[];
    if (Array.isArray(entries) && entries.length > 0) {
      const prior = entries.filter(e => e.date < endStr);
      const last = prior[prior.length - 1];
      if (last !== undefined) return last.date;
    }
  } catch (err) {
    log.warn(`Previous trading day lookup failed: ${toErrorMessage(err)}`);
  }

  for (let offset = 1; offset <= PREVIOUS_DAY_LOOKBACK_DAYS; offset++) {
    const probe = new Date(date.getTime());
    probe.setDate(probe.getDate() - offset);
    const entry = await getTradingDay(probe);
    if (entry !== null) return entry.date;
  }

  return null;
}

export async function queryRequiredWatchlistTradingDay(
  date = getESTDate(),
): Promise<string | null> {
  const todayIsTrading = await isTradingDay(date);
  const previousTradingDay = await getPreviousTradingDay(date);
  return resolveRequiredWatchlistTradingDay({
    todayNy: formatEstDate(date),
    todayIsTrading,
    minutesSinceMidnight: minutesSinceMidnight(date),
    screenerMinutes: config.session.screenerHour * 60 + config.session.screenerMinute,
    previousTradingDay,
    eveningScreenerEnabled: config.screener.eveningScreenerEnabled,
    preMarketMinutes: config.session.preMarketHour * 60 + config.session.preMarketMinute,
  });
}
