import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHeartbeat, suppressDuringStartupGrace } from '../src/watchdogRules';
import { nyWallTimeToUtc, toESTDate } from '../src/utils';
import type { HeartbeatSnapshot, WatchdogFindingCode, WatchdogThresholds } from '../src/types';

const THRESHOLDS: WatchdogThresholds = {
  heartbeatStaleMs: 120_000,
  reportMaxAgeHours: 96,
  reportDueMinute: 16 * 60 + 45,
};

function estInstant(hour: number, minute: number): Date {
  return nyWallTimeToUtc(toESTDate(new Date('2026-08-17T16:00:00Z')), hour, minute);
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
    assert.deepEqual(codes(evaluateHeartbeat(null, estInstant(11, 0), THRESHOLDS)), ['HEARTBEAT_MISSING']);
  });

  it('reports HEARTBEAT_MISSING on a corrupt writtenAt', () => {
    const now = estInstant(11, 0);
    const snapshot = buildSnapshot(now, { writtenAt: 'not-a-date' });
    assert.deepEqual(codes(evaluateHeartbeat(snapshot, now, THRESHOLDS)), ['HEARTBEAT_MISSING']);
  });

  it('is silent before the scan slot even without today\'s report', () => {
    const now = estInstant(11, 0);
    const snapshot = buildSnapshot(now, { reportTradingDay: null, lastScanAt: null });
    assert.deepEqual(evaluateHeartbeat(snapshot, now, THRESHOLDS), []);
  });

  it('reports HEARTBEAT_STALE past the limit and skips the report rule', () => {
    const now = estInstant(17, 0);
    const snapshot = buildSnapshot(now, {
      writtenAt: new Date(now.getTime() - 121_000).toISOString(),
      reportTradingDay: null,
    });
    assert.deepEqual(codes(evaluateHeartbeat(snapshot, now, THRESHOLDS)), ['HEARTBEAT_STALE']);
  });

  it('reports REPORT_STALE after the slot when the report is not today', () => {
    const now = estInstant(17, 0);
    const snapshot = buildSnapshot(now, { reportTradingDay: '2026-08-14' });
    assert.deepEqual(codes(evaluateHeartbeat(snapshot, now, THRESHOLDS)), ['REPORT_STALE']);
  });

  it('suppresses liveness findings during startup grace only', () => {
    const findings = evaluateHeartbeat(null, estInstant(11, 0), THRESHOLDS);
    assert.deepEqual(suppressDuringStartupGrace(findings, 1_000, 120_000), []);
    assert.equal(suppressDuringStartupGrace(findings, 130_000, 120_000).length, 1);
  });
});
