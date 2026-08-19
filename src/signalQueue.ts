import type { PendingSignal, SetupKind } from './types';

const pendingSignals = new Map<string, PendingSignal>();

function byScoreDesc(a: PendingSignal, b: PendingSignal): number {
  return b.score - a.score;
}

export function enqueue(signal: PendingSignal): void {
  pendingSignals.set(signal.symbol, signal);
}

/** Pending signals ranked by `PendingSignal.score` descending. */
export function getPendingSignals(): PendingSignal[] {
  return [...pendingSignals.values()].sort(byScoreDesc);
}

export function remove(symbols: string[]): void {
  for (const sym of symbols) {
    pendingSignals.delete(sym);
  }
}

export function removeBySetup(setup: SetupKind): void {
  for (const [sym, signal] of pendingSignals) {
    if (signal.setup === setup) pendingSignals.delete(sym);
  }
}

export function clear(): void {
  pendingSignals.clear();
}

export function size(): number {
  return pendingSignals.size;
}
