/**
 * Projects any instant onto America/New_York wall-clock time. The returned Date
 * carries the EST/EDT calendar fields in its local getters — it is a wall-clock
 * carrier, not a valid instant, and must never be compared to Date.now().
 */
export function toESTDate(instant: Date): Date {
  return new Date(instant.toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

export function getESTDate(): Date {
  return toESTDate(new Date());
}

/** Minutes since local midnight for a wall-clock carrier from toESTDate(). */
export function minutesSinceMidnight(est: Date): number {
  return est.getHours() * 60 + est.getMinutes();
}

/**
 * YYYY-MM-DD key from a wall-clock carrier. Uses local getters on purpose:
 * toISOString would re-project the carrier to UTC and shift the calendar day.
 */
export function estCalendarDayKey(est: Date): string {
  const month = String(est.getMonth() + 1).padStart(2, '0');
  const day = String(est.getDate()).padStart(2, '0');
  return `${est.getFullYear()}-${month}-${day}`;
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

/**
 * Latest instant a feed will actually serve, for a requested query end.
 *
 * A SIP plan without real-time entitlement rejects any window whose end falls
 * inside the delay period, and rejects the whole request with 403 rather than
 * truncating it. Callers must clamp up front: the failure is indistinguishable
 * from a credentials problem once it surfaces.
 */
export function clampQueryEnd(
  requestedEnd: Date,
  feed: 'iex' | 'sip',
  sipDelayMs: number,
  now: Date = new Date(),
): Date {
  if (feed !== 'sip') return requestedEnd;
  const latest = new Date(now.getTime() - sipDelayMs);
  return requestedEnd.getTime() > latest.getTime() ? latest : requestedEnd;
}

/**
 * True when the stock stream refused the feed for licensing, not credentials.
 * Alpaca returns this on `v2/sip` without Algo Trader Plus (code 409).
 */
export function isSipStreamDenied(code: number, message: string): boolean {
  if (code === 409) return true;
  const text = message.toLowerCase();
  return (
    text.includes('insufficient subscription') ||
    text.includes('subscription does not permit')
  );
}

/** IEX live stream refused the subscribe payload as over the 30-stream cap. */
export function isSymbolLimitExceeded(code: number, message: string): boolean {
  if (code === 405) return true;
  return message.toLowerCase().includes('symbol limit exceeded');
}

/** Alpaca HTTP 429 — REST bars, snapshots, and order submit share this shape. */
export function isRateLimitError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null) {
    const status = (err as { response?: { status?: number } }).response?.status;
    if (status === 429) return true;
  }
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return message.includes('429') || /too many requests/i.test(message);
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
