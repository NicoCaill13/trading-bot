import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateStreamChannels,
  countStreams,
  describeStreamPlan,
  uniqueSymbols,
} from '../src/streamSubscriptions';

const FULL = { maxStreams: 30, quotesEnabled: true, tradesEnabled: true };

describe('uniqueSymbols', () => {
  it('preserves order and drops duplicates', () => {
    assert.deepEqual(uniqueSymbols(['SMCI', 'INTC', 'SMCI', '']), ['SMCI', 'INTC']);
  });
});

describe('allocateStreamChannels', () => {
  it('fits 8 names × 3 channels under the IEX cap (yesterday live)', () => {
    const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    const plan = allocateStreamChannels(names, FULL);
    assert.deepEqual(plan.bars, names);
    assert.deepEqual(plan.quotes, names);
    assert.deepEqual(plan.trades, names);
    assert.equal(countStreams(plan), 24);
  });

  it('keeps bars on 17 names and spends the leftover 13 on tape (today 405)', () => {
    const names = Array.from({ length: 17 }, (_, i) => `S${i}`);
    const plan = allocateStreamChannels(names, FULL);
    assert.deepEqual(plan.bars, names);
    assert.deepEqual(plan.trades, names.slice(0, 13));
    assert.deepEqual(plan.quotes, []);
    assert.equal(countStreams(plan), 30);
  });

  it('caps 40 names at 30 bars and drops quotes/trades', () => {
    const names = Array.from({ length: 40 }, (_, i) => `S${i}`);
    const plan = allocateStreamChannels(names, FULL);
    assert.equal(plan.bars.length, 30);
    assert.deepEqual(plan.quotes, []);
    assert.deepEqual(plan.trades, []);
    assert.equal(countStreams(plan), 30);
  });

  it('bars-only uses the full cap on tickers', () => {
    const names = Array.from({ length: 17 }, (_, i) => `S${i}`);
    const plan = allocateStreamChannels(names, {
      maxStreams: 30,
      quotesEnabled: false,
      tradesEnabled: false,
    });
    assert.deepEqual(plan.bars, names);
    assert.deepEqual(plan.quotes, []);
    assert.deepEqual(plan.trades, []);
    assert.equal(countStreams(plan), 17);
  });

  it('fits 25 movers plus 2 open positions under the IEX cap (bars-only)', () => {
    const movers = Array.from({ length: 25 }, (_, i) => `M${i}`);
    const live = [...movers, 'POS1', 'POS2'];
    const plan = allocateStreamChannels(live, {
      maxStreams: 30,
      quotesEnabled: false,
      tradesEnabled: false,
    });
    assert.equal(plan.bars.length, 27);
    assert.deepEqual(plan.quotes, []);
    assert.deepEqual(plan.trades, []);
    assert.ok(countStreams(plan) <= 30);
  });

  it('never exceeds maxStreams', () => {
    const names = Array.from({ length: 50 }, (_, i) => `S${i}`);
    const plan = allocateStreamChannels(names, { maxStreams: 30, quotesEnabled: true, tradesEnabled: true });
    assert.ok(countStreams(plan) <= 30);
  });
});

describe('describeStreamPlan', () => {
  it('renders channel counts', () => {
    assert.equal(
      describeStreamPlan({ bars: ['A'], quotes: [], trades: ['A'] }),
      '1 bars, 0 quotes, 1 trades (2 streams)',
    );
  });
});
