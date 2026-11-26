import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHeartbeat, suppressDuringStartupGrace } from '../src/watchdogRules';
import { toZonedDate, zonedWallTimeToUtc } from '../src/utils';
import type { HeartbeatSnapshot, WatchdogFindingCode, WatchdogThresholds } from '../src/types';

const PARIS = 'Europe/Paris';

const THRESHOLDS: WatchdogThresholds = {
  heartbeatStaleMs: 120_000,
  reportMaxAgeHours: 96,
  reportDueMinute: 14 * 60 + 20,
  reportDueTimeZone: PARIS,
};

function parisInstant(hour: number, minute: number): Date {
  const wall = toZonedDate(new Date('2026-08-17T12:00:00Z'), PARIS);
  return zonedWallTimeToUtc(wall, hour, minute, PARIS);
}

function buildSnapshot(
  now: Date,
  overrides: Partial<HeartbeatSnapshot> = {},
): HeartbeatSnapshot {
  const started = new Date(now.getTime() - 30 * 60_000).toISOString();
  return {
    writtenAt: now.toISOString(),
    startedAt: started,
    pid: 1234,
    sessionPhase: 'idle',
    sessionPhaseSince: started,
    tradingDay: true,
    lastScanAt: new Date(now.getTime() - 60 * 60_000).toISOString(),
    reportTradingDay: '2026-08-17',
    candidateCount: 3,
    ...overrides,
  };
}

function codes(findings: { code: WatchdogFindingCode }[]): WatchdogFindingCode[] {
  return findings.map(finding => finding.code);
}

describe('evaluateHeartbeat', () => {
  it('reports HEARTBEAT_MISSING when no snapshot is readable', () => {
    assert.deepEqual(codes(evaluateHeartbeat(null, parisInstant(13, 0), THRESHOLDS)), ['HEARTBEAT_MISSING']);
  });

  it('reports HEARTBEAT_MISSING on a corrupt writtenAt', () => {
    const now = parisInstant(13, 0);
    const snapshot = buildSnapshot(now, { writtenAt: 'not-a-date' });
    assert.deepEqual(codes(evaluateHeartbeat(snapshot, now, THRESHOLDS)), ['HEARTBEAT_MISSING']);
  });

  it('is silent before the scan slot even without a scan today', () => {
    const now = parisInstant(13, 0);
    const snapshot = buildSnapshot(now, { reportTradingDay: null, lastScanAt: null });
    assert.deepEqual(evaluateHeartbeat(snapshot, now, THRESHOLDS), []);
  });

  it('reports HEARTBEAT_STALE past the limit and skips the report rule', () => {
    const now = parisInstant(15, 0);
    const snapshot = buildSnapshot(now, {
      writtenAt: new Date(now.getTime() - 121_000).toISOString(),
      reportTradingDay: null,
    });
    assert.deepEqual(codes(evaluateHeartbeat(snapshot, now, THRESHOLDS)), ['HEARTBEAT_STALE']);
  });

  it('accepts a morning scan of the previous US session', () => {
    const now = parisInstant(14, 30);
    const snapshot = buildSnapshot(now, {
      lastScanAt: parisInstant(14, 5).toISOString(),
      reportTradingDay: '2026-08-14',
    });
    assert.deepEqual(evaluateHeartbeat(snapshot, now, THRESHOLDS), []);
  });

  it('reports REPORT_STALE after the slot when today was not scanned', () => {
    const now = parisInstant(14, 30);
    const snapshot = buildSnapshot(now, {
      lastScanAt: '2026-08-14T12:05:00.000Z',
      reportTradingDay: '2026-08-14',
    });
    assert.deepEqual(codes(evaluateHeartbeat(snapshot, now, THRESHOLDS)), ['REPORT_STALE']);
  });

  it('suppresses liveness findings during startup grace only', () => {
    const findings = evaluateHeartbeat(null, parisInstant(13, 0), THRESHOLDS);
    assert.deepEqual(suppressDuringStartupGrace(findings, 1_000, 120_000), []);
    assert.equal(suppressDuringStartupGrace(findings, 130_000, 120_000).length, 1);
  });
});
