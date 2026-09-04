/**
 * Opening-extension scanner — ranks the eligible pool by (last − open) / open.
 *
 * Alpaca client is injected so the ranker can be unit-tested with mock snapshots.
 */

import type { AlpacaSnapshot } from '@alpacahq/alpaca-trade-api';
import {
  compareOpeningExtensionRank,
  computeOpeningExtensionPct,
  passesOpeningExtensionGates,
} from './screenerMath';
import {
  extractLastPrint,
  extractPreviousClose,
  extractSessionOpen,
  extractSessionVolume,
  resolveSnapshotTicker,
} from './snapshotFields';
import { toErrorMessage } from './utils';
import { createLogger } from './logger';
import type { EligiblePoolEntry } from './eligiblePool';
import type { WatchlistSymbol } from './types';

const log = createLogger('OPENING_SCANNER');
const SNAPSHOT_BATCH_SIZE = 100;

/** Inclusive clock window in minutes since NY midnight. */
export function isScannerClockWindow(
  minutesSinceMidnight: number,
  startMinutes: number,
  endMinutes: number,
): boolean {
  return minutesSinceMidnight >= startMinutes && minutesSinceMidnight <= endMinutes;
}

export interface SnapshotClient {
  getSnapshots(symbols: string[]): Promise<AlpacaSnapshot[]>;
}

export interface OpeningMover {
  symbol: string;
  last: number;
  sessionOpen: number;
  previousClose: number;
  rthDollarVolume: number;
  extensionPct: number;
}

export interface OpeningScannerOpts {
  minPrice: number;
  maxPrice: number;
  minExtensionPct: number;
  minRthDollarVolume: number;
  maxSymbols: number;
  pinned: ReadonlySet<string>;
}

export function snapshotToOpeningMover(snap: AlpacaSnapshot): OpeningMover | null {
  const symbol = resolveSnapshotTicker(snap);
  const last = extractLastPrint(snap);
  const sessionOpen = extractSessionOpen(snap);
  const previousClose = extractPreviousClose(snap);
  if (symbol === null || last === null || sessionOpen === null || previousClose === null) {
    return null;
  }
  const extensionPct = computeOpeningExtensionPct(last, sessionOpen);
  if (extensionPct === null) return null;
  const sessionVolume = extractSessionVolume(snap);
  return {
    symbol,
    last,
    sessionOpen,
    previousClose,
    rthDollarVolume: last * sessionVolume,
    extensionPct,
  };
}

/**
 * Rank unpinned names by opening extension, then prepend pinned symbols (armed
 * or already in a position) so they stay in the live universe without competing.
 */
export function rankOpeningMovers(
  hits: readonly OpeningMover[],
  opts: OpeningScannerOpts,
): OpeningMover[] {
  const gated = hits.filter(hit =>
    passesOpeningExtensionGates(
      {
        last: hit.last,
        sessionOpen: hit.sessionOpen,
        previousClose: hit.previousClose,
        rthDollarVolume: hit.rthDollarVolume,
      },
      {
        minPrice: opts.minPrice,
        maxPrice: opts.maxPrice,
        minExtensionPct: opts.minExtensionPct,
        minRthDollarVolume: opts.minRthDollarVolume,
      },
    ),
  );

  const pinnedHits: OpeningMover[] = [];
  const ranked: OpeningMover[] = [];
  for (const hit of gated) {
    if (opts.pinned.has(hit.symbol)) pinnedHits.push(hit);
    else ranked.push(hit);
  }

  ranked.sort(compareOpeningExtensionRank);
  const slots = Math.max(0, opts.maxSymbols - pinnedHits.length);
  const selected = [...pinnedHits, ...ranked.slice(0, slots)];

  const seen = new Set<string>();
  const unique: OpeningMover[] = [];
  for (const hit of selected) {
    if (seen.has(hit.symbol)) continue;
    seen.add(hit.symbol);
    unique.push(hit);
  }

  for (const symbol of opts.pinned) {
    if (seen.has(symbol)) continue;
    // Pinned name missing from this snapshot pass — keep a stub so swap retains it.
    unique.push({
      symbol,
      last: 0,
      sessionOpen: 0,
      previousClose: 0,
      rthDollarVolume: 0,
      extensionPct: 0,
    });
    seen.add(symbol);
  }

  return unique.slice(0, opts.maxSymbols);
}

export function moversToWatchlist(movers: readonly OpeningMover[]): WatchlistSymbol[] {
  return movers.map(m => ({
    symbol: m.symbol,
    origin: 'V2_PLAYMAKER' as const,
    source: 'satellite' as const,
    lastClose: m.last > 0 ? m.last : undefined,
    lastOpen: m.sessionOpen > 0 ? m.sessionOpen : undefined,
    previousClose: m.previousClose > 0 ? m.previousClose : undefined,
    dollarVolume: m.rthDollarVolume > 0 ? m.rthDollarVolume : undefined,
    preMarketGapPct:
      m.last > 0 && m.previousClose > 0
        ? (m.last - m.previousClose) / m.previousClose
        : undefined,
  }));
}

export async function scanSessionExtension(
  pool: readonly EligiblePoolEntry[],
  client: SnapshotClient,
  opts: OpeningScannerOpts,
): Promise<OpeningMover[]> {
  const hits: OpeningMover[] = [];
  const symbols = pool.map(e => e.symbol);

  for (let i = 0; i < symbols.length; i += SNAPSHOT_BATCH_SIZE) {
    const batch = symbols.slice(i, i + SNAPSHOT_BATCH_SIZE);
    try {
      const snapshots = await client.getSnapshots(batch);
      for (const snap of snapshots) {
        const mover = snapshotToOpeningMover(snap);
        if (mover !== null) hits.push(mover);
      }
    } catch (err) {
      log.warn(
        `Snapshot batch [${i}–${Math.min(i + SNAPSHOT_BATCH_SIZE, symbols.length) - 1}] ` +
        `skipped: ${toErrorMessage(err)}`,
      );
    }

    if (i + SNAPSHOT_BATCH_SIZE < symbols.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  const selected = rankOpeningMovers(hits, opts);
  log.info(
    `Scan ${hits.length} prints → ${selected.length} movers ` +
    `(pinned ${opts.pinned.size}, cap ${opts.maxSymbols})`,
  );
  selected.slice(0, 12).forEach(m => {
    if (m.last <= 0) return;
    log.info(
      `  ${m.symbol.padEnd(6)} | ext ${(m.extensionPct * 100).toFixed(2)}% ` +
      `| open $${m.sessionOpen.toFixed(2)} last $${m.last.toFixed(2)} ` +
      `| $vol ${Math.round(m.rthDollarVolume).toLocaleString()}` +
      (opts.pinned.has(m.symbol) ? ' | pinned' : ''),
    );
  });
  return selected;
}
