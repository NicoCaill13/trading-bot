import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createHeartbeatWriter,
  isHeartbeatSnapshot,
  readHeartbeat,
  writeHeartbeat,
} from '../src/heartbeat';
import type { HeartbeatSnapshot } from '../src/types';

const SNAPSHOT: HeartbeatSnapshot = {
  writtenAt: '2026-08-17T14:00:00.000Z',
  startedAt: '2026-08-17T13:00:00.000Z',
  pid: 4242,
  sessionPhase: 'idle',
  sessionPhaseSince: '2026-08-17T13:30:00.000Z',
  tradingDay: true,
  lastScanAt: '2026-08-17T20:30:00.000Z',
  reportTradingDay: '2026-08-17',
  candidateCount: 4,
};

let tmpDir: string;
let filePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeat-test-'));
  filePath = path.join(tmpDir, 'nested', 'heartbeat.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('heartbeat IO', () => {
  it('creates missing directories and round-trips a snapshot', () => {
    writeHeartbeat(filePath, SNAPSHOT);
    assert.deepEqual(readHeartbeat(filePath), SNAPSHOT);
  });

  it('leaves no temp file behind', () => {
    writeHeartbeat(filePath, SNAPSHOT);
    const leftovers = fs.readdirSync(path.dirname(filePath)).filter(f => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  it('returns null for a missing file', () => {
    assert.equal(readHeartbeat(filePath), null);
  });

  it('returns null for malformed JSON instead of throwing', () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{ "writtenAt": ', 'utf8');
    assert.equal(readHeartbeat(filePath), null);
  });

  it('returns null when a required field is absent', () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const { pid: _pid, ...partial } = SNAPSHOT;
    fs.writeFileSync(filePath, JSON.stringify(partial), 'utf8');
    assert.equal(readHeartbeat(filePath), null);
  });
});

describe('isHeartbeatSnapshot', () => {
  it('rejects non-objects', () => {
    assert.equal(isHeartbeatSnapshot(null), false);
    assert.equal(isHeartbeatSnapshot('x'), false);
    assert.equal(isHeartbeatSnapshot([SNAPSHOT]), false);
  });

  it('rejects an unknown session phase', () => {
    assert.equal(isHeartbeatSnapshot({ ...SNAPSHOT, sessionPhase: 'lunch' }), false);
  });

  it('accepts null scan fields', () => {
    const withNulls = { ...SNAPSHOT, lastScanAt: null, reportTradingDay: null };
    assert.equal(isHeartbeatSnapshot(withNulls), true);
  });

  it('rejects a snapshot missing the report day', () => {
    const { reportTradingDay: _day, ...partial } = SNAPSHOT;
    assert.equal(isHeartbeatSnapshot(partial), false);
  });
});

describe('createHeartbeatWriter', () => {
  it('writes once on start and again on flush', () => {
    let calls = 0;
    const writer = createHeartbeatWriter(filePath, 60_000, () => {
      calls++;
      return { ...SNAPSHOT, pid: calls };
    });

    writer.start();
    assert.equal(calls, 1);
    writer.flush();
    assert.equal(readHeartbeat(filePath)?.pid, 2);
    writer.stop();
  });

  it('never throws when the snapshot builder fails', () => {
    const writer = createHeartbeatWriter(filePath, 60_000, () => {
      throw new Error('builder exploded');
    });
    assert.doesNotThrow(() => { writer.start(); });
    writer.stop();
  });
});

