import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHeartbeat, suppressDuringStartupGrace } from '../src/watchdogRules';
import { nyWallTimeToUtc, toESTDate } from '../src/utils';
import type { HeartbeatSnapshot, WatchdogFindingCode, WatchdogThresholds } from '../src/types';

const THRESHOLDS: WatchdogThresholds = {
  heartbeatStaleMs: 120_000,
  marketDataStaleMs: 180_000,
  watchlistMaxAgeHours: 96,
  openPositionCheckHour: 16,
  openPositionCheckMinute: 5,
  openPositionDataMaxAgeMs: 600_000,
};

/** 2026-08-17 is a Monday. 11:00 EST sits inside the regular session. */
function estInstant(hour: number, minute: number): Date {
  return nyWallTimeToUtc(toESTDate(new Date('2026-08-17T12:00:00Z')), hour, minute);
}

function buildSnapshot(
  now: Date,
  overrides: Partial<HeartbeatSnapshot> = {},
): HeartbeatSnapshot {
  const sessionStart = new Date(now.getTime() - 30 * 60_000).toISOString();
  return {
    writtenAt: now.toISOString(),
    startedAt: sessionStart,
    pid: 1234,
    sessionPhase: 'session',
    sessionPhaseSince: sessionStart,
    tradingDay: true,
    tradingHalted: false,
    wsState: 'authenticated',
    lastBarAt: new Date(now.getTime() - 10_000).toISOString(),
    monitoredSymbols: 44,
    openPositions: 0,
    openPositionsCheckedAt: new Date(now.getTime() - 20_000).toISOString(),
    watchlistGeneratedAt: new Date(now.getTime() - 12 * 3_600_000).toISOString(),
    ...overrides,
  };
}

function codes(findings: { code: WatchdogFindingCode }[]): WatchdogFindingCode[] {
  return findings.map(f => f.code);
}

describe('evaluateHeartbeat — process liveness', () => {
  it('reports HEARTBEAT_MISSING when no snapshot is readable', () => {
    const findings = evaluateHeartbeat(null, estInstant(11, 0), THRESHOLDS);
    assert.deepEqual(codes(findings), ['HEARTBEAT_MISSING']);
  });

  it('reports HEARTBEAT_MISSING on a corrupt writtenAt', () => {
    const now = estInstant(11, 0);
    const snapshot = buildSnapshot(now, { writtenAt: 'not-a-date' });
    assert.deepEqual(codes(evaluateHeartbeat(snapshot, now, THRESHOLDS)), ['HEARTBEAT_MISSING']);
  });

  it('is silent on a healthy fresh snapshot', () => {
    const now = estInstant(11, 0);
    assert.deepEqual(evaluateHeartbeat(buildSnapshot(now), now, THRESHOLDS), []);
  });

  it('reports HEARTBEAT_STALE past the limit', () => {
    const now = estInstant(11, 0);
    const snapshot = buildSnapshot(now, {
      writtenAt: new Date(now.getTime() - 121_000).toISOString(),
    });
    assert.deepEqual(codes(evaluateHeartbeat(snapshot, now, THRESHOLDS)), ['HEARTBEAT_STALE']);
  });

  it('suppresses payload rules when the heartbeat itself is stale', () => {
    const now = estInstant(11, 0);
    const snapshot = buildSnapshot(now, {
      writtenAt: new Date(now.getTime() - 600_000).toISOString(),
      lastBarAt: new Date(now.getTime() - 600_000).toISOString(),
      watchlistGeneratedAt: new Date(now.getTime() - 5000 * 3_600_000).toISOString(),
    });
    assert.deepEqual(codes(evaluateHeartbeat(snapshot, now, THRESHOLDS)), ['HEARTBEAT_STALE']);
  });
});

describe('evaluateHeartbeat — market data freshness', () => {
  it('reports MARKET_DATA_STALE when bars stop during the session', () => {
    const now = estInstant(11, 0);
    const snapshot = buildSnapshot(now, {
      lastBarAt: new Date(now.getTime() - 200_000).toISOString(),
    });
    assert.deepEqual(codes(evaluateHeartbeat(snapshot, now, THRESHOLDS)), ['MARKET_DATA_STALE']);
  });

  it('grants a grace period right after the phase change', () => {
    const now = estInstant(9, 31);
    const snapshot = buildSnapshot(now, {
      sessionPhaseSince: new Date(now.getTime() - 60_000).toISOString(),
      lastBarAt: null,
    });
    assert.deepEqual(evaluateHeartbeat(snapshot, now, THRESHOLDS), []);
  });

  it('reports a session that never received a single bar', () => {
    const now = estInstant(10, 30);
    const snapshot = buildSnapshot(now, { lastBarAt: null });
    assert.deepEqual(codes(evaluateHeartbeat(snapshot, now, THRESHOLDS)), ['MARKET_DATA_STALE']);
  });

  it('stays silent outside the session', () => {
    const now = estInstant(8, 0);
    const snapshot = buildSnapshot(now, { sessionPhase: 'pre_open', lastBarAt: null });
    assert.deepEqual(evaluateHeartbeat(snapshot, now, THRESHOLDS), []);
  });

  it('stays silent once trading is halted', () => {
    const now = estInstant(11, 0);
    const snapshot = buildSnapshot(now, {
      tradingHalted: true,
      lastBarAt: new Date(now.getTime() - 600_000).toISOString(),
    });
    assert.deepEqual(evaluateHeartbeat(snapshot, now, THRESHOLDS), []);
  });
});

describe('evaluateHeartbeat — watchlist freshness', () => {
  it('accepts a watchlist generated the previous evening', () => {
    const now = estInstant(10, 0);
    const snapshot = buildSnapshot(now, {
      watchlistGeneratedAt: new Date(now.getTime() - 14 * 3_600_000).toISOString(),
    });
    assert.deepEqual(evaluateHeartbeat(snapshot, now, THRESHOLDS), []);
  });

  it('accepts a watchlist generated before a long weekend', () => {
    const now = estInstant(10, 0);
    const snapshot = buildSnapshot(now, {
      watchlistGeneratedAt: new Date(now.getTime() - 90 * 3_600_000).toISOString(),
    });
    assert.deepEqual(evaluateHeartbeat(snapshot, now, THRESHOLDS), []);
  });

  it('rejects a months-old watchlist', () => {
    const now = estInstant(10, 0);
    const snapshot = buildSnapshot(now, {
      watchlistGeneratedAt: '2026-05-25T00:01:01.157Z',
    });
    assert.deepEqual(codes(evaluateHeartbeat(snapshot, now, THRESHOLDS)), ['WATCHLIST_STALE']);
  });

  it('rejects a missing generation timestamp', () => {
    const now = estInstant(10, 0);
    const snapshot = buildSnapshot(now, { watchlistGeneratedAt: null });
    assert.deepEqual(codes(evaluateHeartbeat(snapshot, now, THRESHOLDS)), ['WATCHLIST_STALE']);
  });
});

describe('evaluateHeartbeat — overnight exposure', () => {
  it('reports positions still open after the deadline', () => {
    const now = estInstant(16, 30);
    const snapshot = buildSnapshot(now, {
      sessionPhase: 'post_close',
      openPositions: 2,
      openPositionsCheckedAt: new Date(now.getTime() - 30_000).toISOString(),
    });
    assert.deepEqual(
      codes(evaluateHeartbeat(snapshot, now, THRESHOLDS)),
      ['POSITIONS_OPEN_AFTER_CLOSE'],
    );
  });

  it('stays silent before the deadline', () => {
    const now = estInstant(15, 0);
    const snapshot = buildSnapshot(now, { openPositions: 2 });
    assert.deepEqual(evaluateHeartbeat(snapshot, now, THRESHOLDS), []);
  });

  it('stays silent when the position count is too old to trust', () => {
    const now = estInstant(16, 30);
    const snapshot = buildSnapshot(now, {
      sessionPhase: 'post_close',
      openPositions: 2,
      openPositionsCheckedAt: new Date(now.getTime() - 900_000).toISOString(),
    });
    assert.deepEqual(evaluateHeartbeat(snapshot, now, THRESHOLDS), []);
  });

  it('stays silent on a non-trading day', () => {
    const now = estInstant(16, 30);
    const snapshot = buildSnapshot(now, {
      sessionPhase: 'non_trading_day',
      tradingDay: false,
      openPositions: 2,
    });
    assert.deepEqual(evaluateHeartbeat(snapshot, now, THRESHOLDS), []);
  });
});

describe('suppressDuringStartupGrace', () => {
  const GRACE_MS = 120_000;

  it('hides a missing heartbeat while the bot is still booting', () => {
    const findings = suppressDuringStartupGrace(
      [{ code: 'HEARTBEAT_MISSING', message: 'x' }],
      30_000,
      GRACE_MS,
    );
    assert.deepEqual(findings, []);
  });

  it('hides a stale heartbeat while the bot is still booting', () => {
    const findings = suppressDuringStartupGrace(
      [{ code: 'HEARTBEAT_STALE', message: 'x' }],
      30_000,
      GRACE_MS,
    );
    assert.deepEqual(findings, []);
  });

  it('reports a missing heartbeat once the grace has elapsed', () => {
    const findings = suppressDuringStartupGrace(
      [{ code: 'HEARTBEAT_MISSING', message: 'x' }],
      GRACE_MS,
      GRACE_MS,
    );
    assert.deepEqual(codes(findings), ['HEARTBEAT_MISSING']);
  });

  it('never hides a finding derived from a fresh snapshot', () => {
    const findings = suppressDuringStartupGrace(
      [
        { code: 'POSITIONS_OPEN_AFTER_CLOSE', message: 'x' },
        { code: 'MARKET_DATA_STALE', message: 'y' },
      ],
      1000,
      GRACE_MS,
    );
    assert.deepEqual(codes(findings), ['POSITIONS_OPEN_AFTER_CLOSE', 'MARKET_DATA_STALE']);
  });
});
