import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import {
  applySlippageToBar,
  buildSimulatedFills,
  loadReplayEvents,
  parseReplayEvents,
  runReplay,
  sortReplayEvents,
} from './replayEngine';
import { createMarketDataBus } from './marketDataBus';
import type { MarketDataEvent } from './types';

function barEvent(
  symbol: string,
  receivedAt: number,
  close: number,
): MarketDataEvent {
  return {
    kind: 'bar_1m',
    receivedAt,
    bar: {
      T: 'b',
      S: symbol,
      o: close - 0.1,
      h: close + 0.2,
      l: close - 0.2,
      c: close,
      v: 1000,
      t: '2026-08-10T14:00:00.000Z',
    },
  };
}

describe('parseReplayEvents / sortReplayEvents', () => {
  it('parses JSONL and sorts by receivedAt', () => {
    const content = [
      JSON.stringify(barEvent('B', 200, 10)),
      JSON.stringify(barEvent('A', 100, 10)),
    ].join('\n');
    const parsed = parseReplayEvents(content);
    const sorted = sortReplayEvents(parsed);
    assert.equal(sorted[0].bar.S, 'A');
    assert.equal(sorted[1].bar.S, 'B');
  });

  it('is deterministic for the same input', () => {
    const a = parseReplayEvents(JSON.stringify([
      barEvent('X', 3, 1),
      barEvent('Y', 1, 1),
      barEvent('Z', 2, 1),
    ]));
    const b = parseReplayEvents(JSON.stringify([
      barEvent('X', 3, 1),
      barEvent('Y', 1, 1),
      barEvent('Z', 2, 1),
    ]));
    assert.deepEqual(sortReplayEvents(a), sortReplayEvents(b));
  });
});

describe('applySlippageToBar', () => {
  it('applies adverse buy slippage in bps on close', () => {
    const bar = barEvent('AAPL', 1, 100).bar;
    const slipped = applySlippageToBar(bar, 10, 'buy'); // +0.10%
    assert.equal(slipped.c, 100.1);
  });

  it('applies adverse sell slippage downward', () => {
    const bar = barEvent('AAPL', 1, 100).bar;
    const slipped = applySlippageToBar(bar, 10, 'sell');
    assert.equal(slipped.c, 99.9);
  });

  it('is a no-op at 0 bps', () => {
    const bar = barEvent('AAPL', 1, 100).bar;
    assert.deepEqual(applySlippageToBar(bar, 0, 'buy').c, 100);
  });
});

describe('buildSimulatedFills', () => {
  it('pairs raw and fill closes', () => {
    const original = [barEvent('A', 1, 100)];
    const slipped = [barEvent('A', 1, 100.1)];
    const fills = buildSimulatedFills(original, slipped);
    assert.equal(fills[0].rawClose, 100);
    assert.equal(fills[0].fillPrice, 100.1);
  });
});

describe('runReplay', () => {
  it('publishes FIFO into the bus and records fills', async () => {
    const bus = createMarketDataBus({ maxQueueSize: 100, dropPolicy: 'drop_oldest' });
    const events = [
      barEvent('B', 200, 20),
      barEvent('A', 100, 10),
    ];
    const report = await runReplay({
      bus,
      events,
      options: { slippageBps: 10, fillDelayMs: 0, seed: 'test' },
    });

    assert.equal(report.published, 2);
    assert.equal(report.events.length, 2);
    assert.equal(report.events[0].bar.S, 'A');
    assert.equal(report.events[1].bar.S, 'B');
    assert.equal(report.simulatedFills[0].rawClose, 10);
    assert.equal(report.simulatedFills[0].fillPrice, 10.01);
    assert.equal(report.seed, 'test');
    assert.equal(report.expectancy, null);
  });

  it('loads the sample fixture without network', async () => {
    const fixture = path.resolve('fixtures/replay/sample-session.jsonl');
    const events = await loadReplayEvents(fixture);
    assert.equal(events.length, 20);

    const bus = createMarketDataBus({ maxQueueSize: 100, dropPolicy: 'drop_oldest' });
    const report = await runReplay({
      bus,
      events,
      options: { slippageBps: 0, fillDelayMs: 0, seed: '0' },
    });
    assert.equal(report.published, 20);
    assert.equal(report.events.length, 20);
    assert.equal(report.dropped, 0);
  });
});
