import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeLiveAskPrice } from '../src/entryPrice';

const OPTS = { staleAskExcess: 0.01, virtualSlippage: 0.001 };

describe('sanitizeLiveAskPrice', () => {
  it('uses a healthy ask as-is', () => {
    const result = sanitizeLiveAskPrice(
      { ask: 144.55, lastTrade: 144.50, minuteClose: 144.48, signalClose: 144.41 },
      OPTS,
    );
    assert.equal(result.usedStaleAskFallback, false);
    assert.equal(result.price, 144.55);
  });

  it('falls back when IEX ask is a phantom (ENTG: +4.6% ask, last near signal)', () => {
    const last = 144.50;
    const result = sanitizeLiveAskPrice(
      { ask: 151.08, lastTrade: last, minuteClose: 144.41, signalClose: 144.41 },
      OPTS,
    );
    assert.equal(result.usedStaleAskFallback, true);
    assert.equal(result.price, last * 1.001);
  });

  it('falls back to signal close + slippage when ask is stale and last is missing', () => {
    const signal = 144.41;
    const result = sanitizeLiveAskPrice(
      { ask: 151.08, lastTrade: null, minuteClose: null, signalClose: signal },
      OPTS,
    );
    assert.equal(result.usedStaleAskFallback, true);
    assert.equal(result.price, signal * 1.001);
  });

  it('keeps last trade when the move is real (last also > 1% above signal)', () => {
    const last = 150.80;
    const result = sanitizeLiveAskPrice(
      { ask: 151.08, lastTrade: last, minuteClose: 150.70, signalClose: 144.41 },
      OPTS,
    );
    assert.equal(result.usedStaleAskFallback, false);
    assert.equal(result.price, last);
  });

  it('uses last trade when ask is missing', () => {
    const result = sanitizeLiveAskPrice(
      { ask: null, lastTrade: 144.50, minuteClose: 144.40, signalClose: 144.41 },
      OPTS,
    );
    assert.equal(result.usedStaleAskFallback, false);
    assert.equal(result.price, 144.50);
  });

  it('uses signal close when the snapshot is empty', () => {
    const result = sanitizeLiveAskPrice(
      { ask: null, lastTrade: null, minuteClose: null, signalClose: 144.41 },
      OPTS,
    );
    assert.equal(result.usedStaleAskFallback, false);
    assert.equal(result.price, 144.41);
  });
});
