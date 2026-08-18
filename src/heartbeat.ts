import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';
import { toErrorMessage } from './utils';
import type { HeartbeatSnapshot, SessionPhase, WsState } from './types';

const log = createLogger('HEARTBEAT');

const SESSION_PHASES: readonly SessionPhase[] = [
  'pre_open',
  'session',
  'post_close',
  'non_trading_day',
];

const WS_STATES: readonly WsState[] = [
  'disabled',
  'disconnected',
  'connecting',
  'authenticated',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/**
 * Structural validation of an untrusted file. A partially written or
 * schema-drifted snapshot must be treated as "no heartbeat" rather than
 * silently satisfying the watchdog with undefined fields.
 */
export function isHeartbeatSnapshot(value: unknown): value is HeartbeatSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value['writtenAt'] === 'string' &&
    typeof value['startedAt'] === 'string' &&
    typeof value['pid'] === 'number' &&
    typeof value['sessionPhaseSince'] === 'string' &&
    typeof value['tradingDay'] === 'boolean' &&
    typeof value['tradingHalted'] === 'boolean' &&
    typeof value['monitoredSymbols'] === 'number' &&
    typeof value['openPositions'] === 'number' &&
    isNullableString(value['lastBarAt']) &&
    isNullableString(value['openPositionsCheckedAt']) &&
    isNullableString(value['watchlistGeneratedAt']) &&
    SESSION_PHASES.includes(value['sessionPhase'] as SessionPhase) &&
    WS_STATES.includes(value['wsState'] as WsState)
  );
}

/**
 * Atomic write via temp file + rename. A torn read would look like a dead bot to
 * the watchdog, so the reader must never observe a partial file.
 */
export function writeHeartbeat(filePath: string, snapshot: HeartbeatSnapshot): void {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const tmpPath = `${resolved}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2), 'utf8');
  fs.renameSync(tmpPath, resolved);
}

/** Returns null when the file is absent, unreadable or schema-invalid. */
export function readHeartbeat(filePath: string): HeartbeatSnapshot | null {
  try {
    const raw = fs.readFileSync(path.resolve(filePath), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isHeartbeatSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface HeartbeatWriter {
  start(): void;
  stop(): void;
  /** Writes immediately, outside the interval cadence. */
  flush(): void;
}

/**
 * Owns the write cadence only. The snapshot builder is injected so that session
 * state stays owned by the caller — no duplicated bot state inside this module.
 */
export function createHeartbeatWriter(
  filePath: string,
  intervalMs: number,
  buildSnapshot: () => HeartbeatSnapshot,
): HeartbeatWriter {
  let timer: ReturnType<typeof setInterval> | null = null;
  let writeFailureLogged = false;

  const flush = (): void => {
    try {
      writeHeartbeat(filePath, buildSnapshot());
      writeFailureLogged = false;
    } catch (err) {
      // A heartbeat failure must never take down a session. Log once per outage
      // to avoid flooding the log file when the disk is full.
      if (!writeFailureLogged) {
        writeFailureLogged = true;
        log.error(`Heartbeat write failed: ${toErrorMessage(err)}`);
      }
    }
  };

  return {
    start(): void {
      if (timer !== null) return;
      flush();
      timer = setInterval(flush, intervalMs);
      // unref is required for correctness, not just tidiness: an interval that
      // keeps the event loop alive would let a bot with no remaining work emit a
      // fresh heartbeat, hiding the outage from the watchdog.
      timer.unref();
      log.info(`Heartbeat writer started — ${filePath} every ${Math.round(intervalMs / 1000)}s`);
    },
    stop(): void {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
    flush,
  };
}
