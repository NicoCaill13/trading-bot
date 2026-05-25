import alpaca from './alpacaClient';
import { createLogger } from './logger';
import { getESTDate, toErrorMessage } from './utils';

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
