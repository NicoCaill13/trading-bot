import { estCalendarDayKey, minutesSinceMidnight, toESTDate } from './utils';
import type { HeartbeatSnapshot, WatchdogFinding, WatchdogThresholds } from './types';

/**
 * Liveness of the study radar. There is no live tape and no open-order book:
 * the process must keep writing a heartbeat, and a trading day must produce
 * a report once the scan slot has passed.
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

function evaluateReportFreshness(
  snapshot: HeartbeatSnapshot,
  nowMs: number,
  thresholds: WatchdogThresholds,
): WatchdogFinding | null {
  const lastScanMs = parseInstant(snapshot.lastScanAt);
  if (lastScanMs !== null) {
    const ageHours = (nowMs - lastScanMs) / MS_PER_HOUR;
    if (ageHours > thresholds.reportMaxAgeHours) {
      return {
        code: 'REPORT_STALE',
        message:
          `Last scan ${Math.round(ageHours)}h ago ` +
          `(limit ${thresholds.reportMaxAgeHours}h)`,
      };
    }
  }

  if (!snapshot.tradingDay) return null;

  const estNow = toESTDate(new Date(nowMs));
  if (minutesSinceMidnight(estNow) < thresholds.reportDueMinute) return null;

  const today = estCalendarDayKey(estNow);
  if (snapshot.reportTradingDay !== today) {
    return {
      code: 'REPORT_STALE',
      message:
        `Report day ${snapshot.reportTradingDay ?? 'none'} != ${today} ` +
        `after the scan slot`,
    };
  }
  return null;
}

export function suppressDuringStartupGrace(
  findings: readonly WatchdogFinding[],
  watchdogUptimeMs: number,
  graceMs: number,
): WatchdogFinding[] {
  if (watchdogUptimeMs >= graceMs) return [...findings];
  return findings.filter(
    finding => finding.code !== 'HEARTBEAT_MISSING' && finding.code !== 'HEARTBEAT_STALE',
  );
}

export function evaluateHeartbeat(
  snapshot: HeartbeatSnapshot | null,
  now: Date,
  thresholds: WatchdogThresholds,
): WatchdogFinding[] {
  if (snapshot === null) {
    return [{
      code: 'HEARTBEAT_MISSING',
      message: 'No readable heartbeat — radar never started, stopped, or file removed',
    }];
  }

  const nowMs = now.getTime();
  const writtenAtMs = parseInstant(snapshot.writtenAt);
  if (writtenAtMs === null) {
    return [{
      code: 'HEARTBEAT_MISSING',
      message: 'Heartbeat unreadable — corrupt writtenAt timestamp',
    }];
  }

  if (nowMs - writtenAtMs > thresholds.heartbeatStaleMs) {
    return [{
      code: 'HEARTBEAT_STALE',
      message:
        `Heartbeat ${ageSeconds(nowMs, writtenAtMs)}s old ` +
        `(limit ${Math.round(thresholds.heartbeatStaleMs / 1000)}s) — ` +
        `process dead or event loop blocked (pid ${snapshot.pid})`,
    }];
  }

  const report = evaluateReportFreshness(snapshot, nowMs, thresholds);
  return report === null ? [] : [report];
}
