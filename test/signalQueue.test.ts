import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as signalQueue from '../src/signalQueue';
import { parseEnteredSetup } from '../src/types';
import type { BarData, PendingSignal } from '../src/types';

const BAR: BarData = {
  open: 10,
  high: 11,
  low: 9,
  close: 10.5,
  volume: 1000,
  timestamp: '2026-08-19T14:00:00.000Z',
};

function signal(symbol: string, score: number, setup: PendingSignal['setup'] = 'VWAP_PULLBACK'): PendingSignal {
  return {
    symbol,
    setup,
    score,
    barData: BAR,
    vwap: 10,
    avgVolume: 800,
    fibLevels: null,
  };
}

beforeEach(() => {
  signalQueue.clear();
});

describe('signalQueue — unified score order', () => {
  it('ranks by PendingSignal.score descending, ignoring setup', () => {
    signalQueue.enqueue(signal('AAA', 10, 'VWAP_PULLBACK'));
    signalQueue.enqueue(signal('BBB', 50, 'ORB'));
    signalQueue.enqueue(signal('CCC', 30, 'OPENING_DRIVE'));
    assert.deepEqual(
      signalQueue.getPendingSignals().map(s => s.symbol),
      ['BBB', 'CCC', 'AAA'],
    );
  });

  it('overwrites the previous signal for the same symbol', () => {
    signalQueue.enqueue(signal('AAA', 10, 'ORB'));
    signalQueue.enqueue(signal('AAA', 99, 'OPENING_DRIVE'));
    const pending = signalQueue.getPendingSignals();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.setup, 'OPENING_DRIVE');
    assert.equal(pending[0]?.score, 99);
  });

  it('removeBySetup drops only that playbook', () => {
    signalQueue.enqueue(signal('AAA', 10, 'VWAP_PULLBACK'));
    signalQueue.enqueue(signal('BBB', 20, 'ORB'));
    signalQueue.removeBySetup('VWAP_PULLBACK');
    assert.deepEqual(
      signalQueue.getPendingSignals().map(s => s.symbol),
      ['BBB'],
    );
  });
});

describe('parseEnteredSetup', () => {
  it('maps a fill-stamped setup through', () => {
    assert.equal(
      parseEnteredSetup({ symbol: 'AAPL', setup: 'OPENING_DRIVE' }),
      'OPENING_DRIVE',
    );
  });

  it('maps a pre-#31 satellite tier onto ORB', () => {
    assert.equal(parseEnteredSetup({ symbol: 'SOXL', tier: 'satellite' }), 'ORB');
  });

  it('maps a legacy string row onto VWAP_PULLBACK', () => {
    assert.equal(parseEnteredSetup('MSFT'), 'VWAP_PULLBACK');
  });
});
