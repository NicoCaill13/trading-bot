import { createLogger } from './logger';
import type { BusDropPolicy, MarketDataEvent } from './types';

const log = createLogger('BUS');

export type MarketDataHandler = (event: MarketDataEvent) => Promise<void>;

export interface MarketDataBusOptions {
  maxQueueSize: number;
  dropPolicy: BusDropPolicy;
  /** Min ms between overflow warnings (default 5s). */
  warnThrottleMs?: number;
}

export interface MarketDataBus {
  publish(event: MarketDataEvent): void;
  start(handler: MarketDataHandler): void;
  stop(): void;
  clear(): void;
  size(): number;
  droppedCount(): number;
}

const DEFAULT_WARN_THROTTLE_MS = 5_000;

/**
 * FIFO market-data queue with async serial drain and bounded backpressure.
 * WS (or replay #11) publishes; strategy consumes without blocking the socket.
 */
export function createMarketDataBus(options: MarketDataBusOptions): MarketDataBus {
  const maxQueueSize = options.maxQueueSize;
  const dropPolicy = options.dropPolicy;
  const warnThrottleMs = options.warnThrottleMs ?? DEFAULT_WARN_THROTTLE_MS;

  const queue: MarketDataEvent[] = [];
  let handler: MarketDataHandler | null = null;
  let draining = false;
  let started = false;
  let dropped = 0;
  let lastWarnAt = 0;

  function warnDrop(reason: string): void {
    const now = Date.now();
    if (now - lastWarnAt < warnThrottleMs) return;
    lastWarnAt = now;
    log.warn(
      `backpressure ${reason} — policy=${dropPolicy} size=${queue.length} ` +
      `max=${maxQueueSize} dropped_total=${dropped}`,
    );
  }

  function enqueue(event: MarketDataEvent): void {
    if (queue.length >= maxQueueSize) {
      if (dropPolicy === 'drop_oldest') {
        queue.shift();
        dropped += 1;
        warnDrop('drop_oldest');
      } else {
        dropped += 1;
        warnDrop('drop_newest');
        return;
      }
    }
    queue.push(event);
  }

  function scheduleDrain(): void {
    if (!started || draining || handler === null || queue.length === 0) return;
    draining = true;
    setImmediate(() => {
      void drainLoop();
    });
  }

  async function drainLoop(): Promise<void> {
    try {
      while (started && handler !== null && queue.length > 0) {
        const event = queue.shift();
        if (event === undefined) break;
        try {
          await handler(event);
        } catch (err: unknown) {
          log.error(`consumer handler error: ${String(err)}`);
        }
      }
    } finally {
      draining = false;
      if (started && queue.length > 0) {
        scheduleDrain();
      }
    }
  }

  return {
    publish(event: MarketDataEvent): void {
      enqueue(event);
      scheduleDrain();
    },

    start(nextHandler: MarketDataHandler): void {
      handler = nextHandler;
      started = true;
      scheduleDrain();
    },

    stop(): void {
      started = false;
      handler = null;
    },

    clear(): void {
      queue.length = 0;
    },

    size(): number {
      return queue.length;
    },

    droppedCount(): number {
      return dropped;
    },
  };
}
