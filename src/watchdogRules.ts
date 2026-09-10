import { minutesSinceMidnight, toESTDate } from './utils';
import type { HeartbeatSnapshot, WatchdogFinding, WatchdogThresholds } from './types';

/**
 * Pure liveness evaluation. No IO, no config, no clock of its own — the caller
 * injects `now`, which makes every rule below directly unit-testable.
 */

const MS_PER_HOUR = 3_600_000;

function ageSeconds(nowMs: number, thenMs: number): number {
  return Math.round((nowMs - thenMs) / 1000);
}

function parseInstant(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** IEX 1-min bars fire on prints. A 1–2 name Gap Hold tape routinely goes 3–4 min silent. */
const THIN_UNIVERSE_SYMBOLS = 5;
const THIN_UNIVERSE_STALE_MS = 600_000;

function evaluateMarketDataFreshness(
  snapshot: HeartbeatSnapshot,
  nowMs: number,
  thresholds: WatchdogThresholds,
): WatchdogFinding | null {
  const isLiveSession =
    snapshot.tradingDay &&
    snapshot.sessionPhase === 'session' &&
    !snapshot.tradingHalted &&
    snapshot.monitoredSymbols > 0 &&
    snapshot.wsState !== 'disabled';

  if (!isLiveSession) return null;

  const staleLimitMs = snapshot.monitoredSymbols < THIN_UNIVERSE_SYMBOLS
    ? Math.max(thresholds.marketDataStaleMs, THIN_UNIVERSE_STALE_MS)
    : thresholds.marketDataStaleMs;

  // Grace: phase change (open / reconnect) OR a universe swap that just added
  // the first name after an empty Gap Hold scan. sessionPhaseSince stays at
  // 09:30; watchlistGeneratedAt is the clock that actually moved.
  const phaseSinceMs = parseInstant(snapshot.sessionPhaseSince);
  const universeSinceMs = parseInstant(snapshot.watchlistGeneratedAt);
  const graceSinceMs = Math.max(phaseSinceMs ?? 0, universeSinceMs ?? 0);
  if (graceSinceMs <= 0) return null;
  if (nowMs - graceSinceMs <= staleLimitMs) return null;

  const lastBarMs = parseInstant(snapshot.lastBarAt);
  if (lastBarMs === null) {
    return {
      code: 'MARKET_DATA_STALE',
      message:
        `No bar received since the session opened ` +
        `(${ageSeconds(nowMs, graceSinceMs)}s), ws=${snapshot.wsState}`,
    };
  }

  const staleMs = nowMs - lastBarMs;
  if (staleMs > staleLimitMs) {
    return {
      code: 'MARKET_DATA_STALE',
      message:
        `Last bar ${ageSeconds(nowMs, lastBarMs)}s ago ` +
        `(limit ${Math.round(staleLimitMs / 1000)}s), ws=${snapshot.wsState}`,
    };
  }

  return null;
}

/**
 * Calendar match is the source of truth. Age in hours only covers legacy
 * heartbeats that predate watchlistTradingDay / requiredWatchlistTradingDay.
 */
function evaluateWatchlistFreshness(
  snapshot: HeartbeatSnapshot,
  nowMs: number,
  thresholds: WatchdogThresholds,
): WatchdogFinding | null {
  if (!snapshot.tradingDay) return null;

  const have = snapshot.watchlistTradingDay;
  const need = snapshot.requiredWatchlistTradingDay;

  if (typeof need !== 'string') {
    // No universe is due (Hyper-Growth before 09:15). A leftover on-disk day
    // is not a missed screener.
    if (typeof have === 'string') return null;
  } else {
    if (have !== need) {
      return {
        code: 'WATCHLIST_STALE',
        message:
          `Watchlist trading day ${have ?? 'none'} != required ${need} ` +
          `— screener missed or crashed before write`,
      };
    }
    return null;
  }

  const generatedMs = parseInstant(snapshot.watchlistGeneratedAt);
  if (generatedMs === null) {
    return {
      code: 'WATCHLIST_STALE',
      message: 'Watchlist generation timestamp missing or unparseable',
    };
  }

  const ageHours = (nowMs - generatedMs) / MS_PER_HOUR;
  if (ageHours > thresholds.watchlistMaxAgeHours) {
    return {
      code: 'WATCHLIST_STALE',
      message:
        `Watchlist generated ${Math.round(ageHours)}h ago ` +
        `(limit ${thresholds.watchlistMaxAgeHours}h) — screener has not run`,
    };
  }

  return null;
}

/**
 * The highest-value rule: it verifies the expected outcome of the session rather
 * than the liveness of the process. An open position past the hard close means
 * the EOD sweep never fired and overnight risk is live.
 */
function evaluateOvernightExposure(
  snapshot: HeartbeatSnapshot,
  nowMs: number,
  thresholds: WatchdogThresholds,
): WatchdogFinding | null {
  if (!snapshot.tradingDay) return null;
  if (snapshot.openPositions <= 0) return null;

  // Never alert on a stale broker count: a failing position refresh would
  // otherwise raise a phantom overnight exposure every single evening.
  const checkedAtMs = parseInstant(snapshot.openPositionsCheckedAt);
  if (checkedAtMs === null) return null;
  if (nowMs - checkedAtMs > thresholds.openPositionDataMaxAgeMs) return null;

  const estNow = toESTDate(new Date(nowMs));
  const deadlineMinutes =
    thresholds.openPositionCheckHour * 60 + thresholds.openPositionCheckMinute;

  if (minutesSinceMidnight(estNow) < deadlineMinutes) return null;

  const deadline =
    `${String(thresholds.openPositionCheckHour).padStart(2, '0')}:` +
    `${String(thresholds.openPositionCheckMinute).padStart(2, '0')}`;

  return {
    code: 'POSITIONS_OPEN_AFTER_CLOSE',
    message:
      `${snapshot.openPositions} position(s) still open after ${deadline} EST — ` +
      `EOD sweep did not complete, overnight exposure is live`,
  };
}

/**
 * At boot both units start together, so an absent or stale heartbeat is expected
 * for a short while. Only the two liveness codes are suppressed: a snapshot
 * fresh enough to be trusted always gets its findings reported.
 */
export function suppressDuringStartupGrace(
  findings: readonly WatchdogFinding[],
  watchdogUptimeMs: number,
  graceMs: number,
): WatchdogFinding[] {
  if (watchdogUptimeMs >= graceMs) return [...findings];
  return findings.filter(
    f => f.code !== 'HEARTBEAT_MISSING' && f.code !== 'HEARTBEAT_STALE',
  );
}

export function evaluateHeartbeat(
  snapshot: HeartbeatSnapshot | null,
  now: Date,
  thresholds: WatchdogThresholds,
): WatchdogFinding[] {
  if (snapshot === null) {
    return [
      {
        code: 'HEARTBEAT_MISSING',
        message: 'No readable heartbeat — bot never started, stopped, or file removed',
      },
    ];
  }

  const nowMs = now.getTime();
  const writtenAtMs = parseInstant(snapshot.writtenAt);
  if (writtenAtMs === null) {
    return [
      {
        code: 'HEARTBEAT_MISSING',
        message: 'Heartbeat unreadable — corrupt writtenAt timestamp',
      },
    ];
  }

  const heartbeatAgeMs = nowMs - writtenAtMs;
  if (heartbeatAgeMs > thresholds.heartbeatStaleMs) {
    // Every other rule reads the snapshot payload, which is only meaningful
    // while fresh. Reporting them on stale data would produce false findings.
    return [
      {
        code: 'HEARTBEAT_STALE',
        message:
          `Heartbeat ${ageSeconds(nowMs, writtenAtMs)}s old ` +
          `(limit ${Math.round(thresholds.heartbeatStaleMs / 1000)}s) — ` +
          `process dead or event loop blocked (pid ${snapshot.pid})`,
      },
    ];
  }

  const findings: WatchdogFinding[] = [];
  const marketData = evaluateMarketDataFreshness(snapshot, nowMs, thresholds);
  if (marketData !== null) findings.push(marketData);

  const watchlist = evaluateWatchlistFreshness(snapshot, nowMs, thresholds);
  if (watchlist !== null) findings.push(watchlist);

  const overnight = evaluateOvernightExposure(snapshot, nowMs, thresholds);
  if (overnight !== null) findings.push(overnight);

  return findings;
}
