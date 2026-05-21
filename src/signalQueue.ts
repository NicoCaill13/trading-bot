import { createLogger } from './logger';
import type { PendingSignal, SignalTier } from './types';

const log = createLogger('SIGNAL_QUEUE');

// Satellite (Play-Maker / V2) — high-priority bucket, flushed first
const satelliteQueue = new Map<string, PendingSignal>();

// Core (V1) — standard bucket
const coreQueue = new Map<string, PendingSignal>();

// Symbols registered at 09:15 pre-market scan (priority within Satellite bucket)
const satellitePrioritySymbols = new Set<string>();

/**
 * Routes a signal into the correct priority queue by tier.
 */
export function enqueue(signal: PendingSignal): void {
  if (signal.tier === 'satellite') {
    satelliteQueue.set(signal.symbol, signal);
  } else {
    coreQueue.set(signal.symbol, signal);
  }
}

/**
 * Called by the 09:15 pre-market module after watchlist generation.
 * Marks symbols for priority handling within the Satellite bucket.
 */
export function registerSatelliteWatchlist(symbols: string[]): void {
  satellitePrioritySymbols.clear();
  for (const symbol of symbols) {
    satellitePrioritySymbols.add(symbol);
  }
  log.info(`Satellite priority watchlist registered — ${symbols.length} symbol(s)`);
}

export function getSatellitePrioritySymbols(): ReadonlySet<string> {
  return satellitePrioritySymbols;
}

export function getSatelliteSignals(): PendingSignal[] {
  return [...satelliteQueue.values()].sort(compareSatellitePriority);
}

export function getCoreSignals(): PendingSignal[] {
  return [...coreQueue.values()];
}

function compareSatellitePriority(a: PendingSignal, b: PendingSignal): number {
  const aPri = satellitePrioritySymbols.has(a.symbol) ? 1 : 0;
  const bPri = satellitePrioritySymbols.has(b.symbol) ? 1 : 0;
  if (bPri !== aPri) return bPri - aPri;
  return b.score - a.score;
}

export function remove(symbols: string[]): void {
  for (const sym of symbols) {
    satelliteQueue.delete(sym);
    coreQueue.delete(sym);
  }
}

export function clear(): void {
  satelliteQueue.clear();
  coreQueue.clear();
}

export function clearCore(): void {
  coreQueue.clear();
}

export function size(): number {
  return satelliteQueue.size + coreQueue.size;
}

export function satelliteSize(): number {
  return satelliteQueue.size;
}

export function coreSize(): number {
  return coreQueue.size;
}
