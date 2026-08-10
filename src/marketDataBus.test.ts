import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketDataBus } from './marketDataBus';
import type { MarketDataEvent, WsBarMessage } from './types';

function barEvent(symbol: string, receivedAt = Date.now()): MarketDataEvent {
  const bar: WsBarMessage = {
    T: 'b',
    S: symbol,
    o: 1,
    h: 2,
    l: 0.5,
    c: 1.5,
    v: 100,
    t: '2026-08-10T14:00:00Z',
  };
  return { kind: 'bar_1m', receivedAt, bar };
}

function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('waitFor timeout'));
        return;
      }
      setImmediate(tick);
    };
    tick();
  });
}

describe('marketDataBus FIFO', () => {
  it('delivers events in publish order', async () => {
    const bus = createMarketDataBus({ maxQueueSize: 10, dropPolicy: 'drop_oldest' });
    const seen: string[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>(r => {
      resolveDone = r;
    });

    bus.start(async (e) => {
      seen.push(e.bar.S);
      if (seen.length === 3) resolveDone();
    });

    bus.publish(barEvent('A'));
    bus.publish(barEvent('B'));
    bus.publish(barEvent('C'));

    await done;
    assert.deepEqual(seen, ['A', 'B', 'C']);
    bus.stop();
  });
});

describe('marketDataBus async drain', () => {
  it('returns from publish before the handler finishes', async () => {
    const bus = createMarketDataBus({ maxQueueSize: 10, dropPolicy: 'drop_oldest' });
    let handlerStarted = false;
    let handlerFinished = false;

    bus.start(async () => {
      handlerStarted = true;
      await new Promise<void>(r => setTimeout(r, 30));
      handlerFinished = true;
    });

    bus.publish(barEvent('X'));
    assert.equal(handlerFinished, false);

    await waitFor(() => handlerStarted);
    assert.equal(handlerFinished, false);

    await waitFor(() => handlerFinished);
    bus.stop();
  });
});

describe('marketDataBus backpressure', () => {
  it('drop_oldest retains the newest events', async () => {
    const bus = createMarketDataBus({
      maxQueueSize: 3,
      dropPolicy: 'drop_oldest',
      warnThrottleMs: 0,
    });
    const seen: string[] = [];

    // Publish before start so queue fills without draining.
    bus.publish(barEvent('1'));
    bus.publish(barEvent('2'));
    bus.publish(barEvent('3'));
    bus.publish(barEvent('4'));
    bus.publish(barEvent('5'));

    assert.equal(bus.size(), 3);
    assert.ok(bus.droppedCount() >= 2);

    let resolveDone!: () => void;
    const done = new Promise<void>(r => {
      resolveDone = r;
    });
    bus.start(async (e) => {
      seen.push(e.bar.S);
      if (seen.length === 3) resolveDone();
    });

    await done;
    assert.deepEqual(seen, ['3', '4', '5']);
    bus.stop();
  });

  it('drop_newest rejects incoming when full', async () => {
    const bus = createMarketDataBus({
      maxQueueSize: 3,
      dropPolicy: 'drop_newest',
      warnThrottleMs: 0,
    });
    const seen: string[] = [];

    bus.publish(barEvent('1'));
    bus.publish(barEvent('2'));
    bus.publish(barEvent('3'));
    bus.publish(barEvent('4'));
    bus.publish(barEvent('5'));

    assert.equal(bus.size(), 3);
    assert.ok(bus.droppedCount() >= 2);

    let resolveDone!: () => void;
    const done = new Promise<void>(r => {
      resolveDone = r;
    });
    bus.start(async (e) => {
      seen.push(e.bar.S);
      if (seen.length === 3) resolveDone();
    });

    await done;
    assert.deepEqual(seen, ['1', '2', '3']);
    bus.stop();
  });
});

describe('marketDataBus serial consumer', () => {
  it('never runs handlers concurrently', async () => {
    const bus = createMarketDataBus({ maxQueueSize: 20, dropPolicy: 'drop_oldest' });
    let inFlight = 0;
    let maxInFlight = 0;
    let completed = 0;

    bus.start(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>(r => setTimeout(r, 5));
      inFlight -= 1;
      completed += 1;
    });

    for (let i = 0; i < 5; i++) {
      bus.publish(barEvent(`S${i}`));
    }

    await waitFor(() => completed === 5);
    assert.equal(maxInFlight, 1);
    bus.stop();
  });
});

describe('marketDataBus stop', () => {
  it('stops draining after stop()', async () => {
    const bus = createMarketDataBus({ maxQueueSize: 10, dropPolicy: 'drop_oldest' });
    const seen: string[] = [];

    bus.publish(barEvent('A'));
    bus.publish(barEvent('B'));
    bus.stop();

    bus.start(async (e) => {
      seen.push(e.bar.S);
    });

    // stop() cleared the handler binding; start again should drain residual if still queued.
    // After stop without clear, queued events remain — start resumes drain.
    await waitFor(() => seen.length === 2);
    assert.deepEqual(seen, ['A', 'B']);

    bus.stop();
    bus.clear();
    bus.publish(barEvent('C'));
    assert.equal(bus.size(), 1);

    await new Promise<void>(r => setTimeout(r, 20));
    assert.deepEqual(seen, ['A', 'B']);
    bus.clear();
  });
});
