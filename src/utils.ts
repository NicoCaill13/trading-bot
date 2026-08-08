export function getESTDate(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

/**
 * Convert an America/New_York wall-clock time on the given EST calendar day to a UTC Date.
 * Handles EST/EDT via Intl offset probing.
 */
export function nyWallTimeToUtc(
  estCalendarDay: Date,
  hour: number,
  minute: number,
): Date {
  const year = estCalendarDay.getFullYear();
  const month = estCalendarDay.getMonth() + 1;
  const day = estCalendarDay.getDate();

  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetMs = nyOffsetMsAt(new Date(utcGuess));
  let utc = Date.UTC(year, month - 1, day, hour, minute, 0) - offsetMs;
  // Refine once around DST boundaries
  const offset2 = nyOffsetMsAt(new Date(utc));
  utc = Date.UTC(year, month - 1, day, hour, minute, 0) - offset2;
  return new Date(utc);
}

function nyOffsetMsAt(instant: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = dtf.formatToParts(instant);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour === '24' ? '0' : map.hour),
    Number(map.minute),
    Number(map.second),
  );
  return asUtc - instant.getTime();
}

/** Order failures that must not be retried on the next flush (blackout defer loop). */
export function isNonRetryableOrderError(message: string): boolean {
  return (
    message.includes('insufficient 5m history for ATR') ||
    message.includes('invalid 5m ATR value') ||
    message.includes('no slots available') ||
    message.includes('slot envelope insufficient')
  );
}

export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  // Axios / SDK errors expose response.data or response.status
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>;
    const status  = (e['response'] as Record<string, unknown> | undefined)?.['status'];
    const data    = (e['response'] as Record<string, unknown> | undefined)?.['data'];
    const msg     = e['message'];
    if (status !== undefined) return `HTTP ${status}: ${JSON.stringify(data ?? msg)}`;
    if (msg !== undefined)    return String(msg);
    return JSON.stringify(err);
  }
  return String(err);
}
