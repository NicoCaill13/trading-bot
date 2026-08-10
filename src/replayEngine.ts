import fs from 'fs/promises';
import { createLogger } from './logger';
import {
  computeExpectancyMetrics,
  normalizeTradeRecords,
  type ExpectancyMetrics,
} from './expectancy';
import type { MarketDataBus, MarketDataHandler } from './marketDataBus';
import type { MarketDataEvent, TradeRecord, WsBarMessage } from './types';

const log = createLogger('REPLAY');

/** Replay fixtures are bar streams only (quotes out of scope for #11). */
export type ReplayBarEvent = Extract<MarketDataEvent, { kind: 'bar_1m' }>;

export type ReplaySide = 'buy' | 'sell';

export interface ReplayOptions {
  slippageBps: number;
  fillDelayMs: number;
  seed: string;
  side?: ReplaySide;
}

export interface SimulatedFill {
  symbol: string;
  receivedAt: number;
  barTimestamp: string;
  rawClose: number;
  fillPrice: number;
}

export interface ReplayReport {
  published: number;
  dropped: number;
  seed: string;
  slippageBps: number;
  fillDelayMs: number;
  events: ReplayBarEvent[];
  simulatedFills: SimulatedFill[];
  expectancy: ExpectancyMetrics | null;
}

export interface RunReplayParams {
  bus: MarketDataBus;
  events: ReplayBarEvent[];
  options: ReplayOptions;
  handler?: MarketDataHandler;
  /** Optional closed trades for E_R (e.g. journal fixture). */
  trades?: TradeRecord[];
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForDrain(bus: MarketDataBus, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (bus.size() === 0) {
        setImmediate(() => resolve());
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`[REPLAY] drain timeout — queue size=${bus.size()}`));
        return;
      }
      setImmediate(tick);
    };
    tick();
  });
}

function roundPrice(price: number): number {
  return Math.round(price * 100) / 100;
}

function isWsBarMessage(value: unknown): value is WsBarMessage {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v.T === 'b' &&
    typeof v.S === 'string' &&
    typeof v.o === 'number' &&
    typeof v.h === 'number' &&
    typeof v.l === 'number' &&
    typeof v.c === 'number' &&
    typeof v.v === 'number' &&
    typeof v.t === 'string'
  );
}

function isReplayBarEvent(value: unknown): value is ReplayBarEvent {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.kind === 'bar_1m' && typeof v.receivedAt === 'number' && isWsBarMessage(v.bar);
}

/** Parse JSONL or a JSON array of bar_1m MarketDataEvent. */
export function parseReplayEvents(content: string): ReplayBarEvent[] {
  const trimmed = content.trim();
  if (trimmed === '') return [];

  if (trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error('[REPLAY] JSON fixture must be an array of MarketDataEvent');
    }
    return parsed.map((row, i) => {
      if (!isReplayBarEvent(row)) {
        throw new Error(`[REPLAY] invalid MarketDataEvent at index ${i}`);
      }
      return row;
    });
  }

  const events: ReplayBarEvent[] = [];
  const lines = trimmed.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`[REPLAY] invalid JSONL at line ${i + 1}`);
    }
    if (!isReplayBarEvent(parsed)) {
      throw new Error(`[REPLAY] invalid MarketDataEvent at line ${i + 1}`);
    }
    events.push(parsed);
  }
  return events;
}

export async function loadReplayEvents(filePath: string): Promise<ReplayBarEvent[]> {
  const content = await fs.readFile(filePath, 'utf8');
  return parseReplayEvents(content);
}

/** Stable sort by receivedAt, then original index. */
export function sortReplayEvents(events: readonly ReplayBarEvent[]): ReplayBarEvent[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      if (a.event.receivedAt !== b.event.receivedAt) {
        return a.event.receivedAt - b.event.receivedAt;
      }
      return a.index - b.index;
    })
    .map(row => row.event);
}

/**
 * Adverse slippage on close: buy → +bps, sell → -bps.
 * Shifts o/h/l by the same delta so the bar stays coherent.
 */
export function applySlippageToBar(
  bar: WsBarMessage,
  slippageBps: number,
  side: ReplaySide = 'buy',
): WsBarMessage {
  if (slippageBps === 0) return { ...bar };
  const sign = side === 'buy' ? 1 : -1;
  const factor = 1 + sign * (slippageBps / 10_000);
  const newClose = roundPrice(bar.c * factor);
  const delta = newClose - bar.c;
  return {
    ...bar,
    o: roundPrice(bar.o + delta),
    h: roundPrice(bar.h + delta),
    l: roundPrice(bar.l + delta),
    c: newClose,
  };
}

export function applySlippageToEvent(
  event: ReplayBarEvent,
  slippageBps: number,
  side: ReplaySide = 'buy',
): ReplayBarEvent {
  return {
    ...event,
    bar: applySlippageToBar(event.bar, slippageBps, side),
  };
}

export function buildSimulatedFills(
  original: readonly ReplayBarEvent[],
  slipped: readonly ReplayBarEvent[],
): SimulatedFill[] {
  const n = Math.min(original.length, slipped.length);
  const fills: SimulatedFill[] = [];
  for (let i = 0; i < n; i++) {
    fills.push({
      symbol: slipped[i].bar.S,
      receivedAt: slipped[i].receivedAt,
      barTimestamp: slipped[i].bar.t,
      rawClose: original[i].bar.c,
      fillPrice: slipped[i].bar.c,
    });
  }
  return fills;
}

/**
 * Publish sorted events into the market-data bus (same contract as live WS).
 * Default handler records events; live strategy handler wiring is a follow-up.
 */
export async function runReplay(params: RunReplayParams): Promise<ReplayReport> {
  const { bus, options } = params;
  const side = options.side ?? 'buy';
  const sorted = sortReplayEvents(params.events);
  const slipped = sorted.map(e => applySlippageToEvent(e, options.slippageBps, side));
  const simulatedFills = buildSimulatedFills(sorted, slipped);
  const recorded: ReplayBarEvent[] = [];

  const consumer: MarketDataHandler = async (event) => {
    if (event.kind !== 'bar_1m') return;
    recorded.push(event);
    if (params.handler) {
      await params.handler(event);
    }
  };

  bus.clear();
  const droppedBefore = bus.droppedCount();
  bus.start(consumer);

  log.info(
    `starting replay — n=${sorted.length} slippageBps=${options.slippageBps} ` +
    `fillDelayMs=${options.fillDelayMs} seed=${options.seed}`,
  );

  let published = 0;
  for (const event of slipped) {
    if (options.fillDelayMs > 0) {
      await sleep(options.fillDelayMs);
    }
    bus.publish(event);
    published += 1;
  }

  await waitForDrain(bus);
  await sleep(0);
  await waitForDrain(bus);

  bus.stop();
  const dropped = bus.droppedCount() - droppedBefore;
  bus.clear();

  const expectancy = params.trades && params.trades.length > 0
    ? computeExpectancyMetrics(normalizeTradeRecords(params.trades))
    : null;

  const report: ReplayReport = {
    published,
    dropped,
    seed: options.seed,
    slippageBps: options.slippageBps,
    fillDelayMs: options.fillDelayMs,
    events: recorded,
    simulatedFills,
    expectancy,
  };

  log.info(
    `replay done — published=${published} consumed=${recorded.length} ` +
    `dropped=${dropped} fills=${simulatedFills.length}` +
    (expectancy && expectancy.n > 0
      ? ` E_R=${expectancy.eR.toFixed(2)} [${expectancy.scenario}]`
      : ''),
  );

  return report;
}
