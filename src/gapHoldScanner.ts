/**
 * Gap Hold universe — ranks the eligible pool by overnight gap (news track)
 * and yesterday's close quality (continuation track). Snapshot I/O is injected.
 */

import type { NewsProvider } from './newsProvider';
import {
  collectSnapshotMovers,
  type OpeningMover,
  type SnapshotClient,
} from './openingScanner';
import { passesPremarketPricePair } from './screenerMath';
import {
  assessStrictBullishCatalyst,
  type CatalystAssessment,
} from './sentiment';
import { createLogger } from './logger';
import { toErrorMessage } from './utils';
import type { EligiblePoolEntry } from './eligiblePool';
import type { GapHoldTrack, WatchlistSymbol } from './types';

const log = createLogger('GAP_HOLD');

export interface GapHoldScannerOpts {
  minPrice: number;
  maxPrice: number;
  minRthDollarVolume: number;
  maxSymbols: number;
  pinned: ReadonlySet<string>;
  minOvernightGapPct: number;
  maxOvernightGapPct: number;
  continuationMaxGapPct: number;
  minYesterdayReturnPct: number;
  minYesterdayCloseLocation: number;
  gapFillTolerancePct: number;
  newsSlots: number;
  continuationSlots: number;
}

export function classifyGapHoldTrack(
  mover: OpeningMover,
  opts: GapHoldScannerOpts,
): GapHoldTrack | null {
  if (!(mover.last >= mover.sessionOpen) || mover.sessionOpen <= 0) return null;
  if (
    !passesPremarketPricePair(
      mover.last,
      mover.previousClose,
      opts.minPrice,
      opts.maxPrice,
    )
  ) {
    return null;
  }
  if (mover.rthDollarVolume < opts.minRthDollarVolume) return null;

  const fillLine = mover.sessionOpen * (1 - opts.gapFillTolerancePct);
  if (mover.sessionLow !== null && mover.sessionLow < fillLine) return null;

  const gap = mover.overnightGapPct;
  if (
    gap !== null &&
    gap >= opts.minOvernightGapPct &&
    gap <= opts.maxOvernightGapPct
  ) {
    return 'news_gap';
  }

  const yRet = mover.yesterdayReturnPct;
  const yLoc = mover.yesterdayCloseLocation;
  const continuationGapOk =
    gap !== null && gap >= 0 && gap <= opts.continuationMaxGapPct;
  const brokeYesterdayHigh =
    mover.previousHigh !== null && mover.last > mover.previousHigh;
  if (
    continuationGapOk &&
    yRet !== null &&
    yRet >= opts.minYesterdayReturnPct &&
    yLoc !== null &&
    yLoc >= opts.minYesterdayCloseLocation &&
    brokeYesterdayHigh
  ) {
    return 'continuation';
  }

  return null;
}

function newsRankScore(mover: OpeningMover): number {
  return (mover.overnightGapPct ?? 0) * mover.rthDollarVolume;
}

function continuationRankScore(mover: OpeningMover): number {
  return (mover.yesterdayReturnPct ?? 0) * mover.rthDollarVolume;
}

function withTrack(mover: OpeningMover, track: GapHoldTrack): OpeningMover {
  return { ...mover, track };
}

/**
 * News gappers first (slot reserve), then continuation. Pinned names prepended.
 */
export function rankGapHoldMovers(
  hits: readonly OpeningMover[],
  opts: GapHoldScannerOpts,
): OpeningMover[] {
  const news: OpeningMover[] = [];
  const continuation: OpeningMover[] = [];

  for (const hit of hits) {
    if (opts.pinned.has(hit.symbol)) continue;
    const track = classifyGapHoldTrack(hit, opts);
    if (track === 'news_gap') news.push(withTrack(hit, track));
    else if (track === 'continuation') continuation.push(withTrack(hit, track));
  }

  news.sort((a, b) => newsRankScore(b) - newsRankScore(a));
  continuation.sort((a, b) => continuationRankScore(b) - continuationRankScore(a));

  const selected: OpeningMover[] = [];
  const seen = new Set<string>();

  for (const symbol of opts.pinned) {
    const hit = hits.find(h => h.symbol === symbol);
    selected.push(
      hit
        ? { ...hit, track: hit.track ?? classifyGapHoldTrack(hit, opts) ?? undefined }
        : {
            symbol,
            last: 0,
            sessionOpen: 0,
            previousClose: 0,
            rthDollarVolume: 0,
            extensionPct: 0,
            overnightGapPct: null,
            yesterdayReturnPct: null,
            yesterdayCloseLocation: null,
            previousHigh: null,
            previousOpen: null,
            sessionLow: null,
          },
    );
    seen.add(symbol);
  }

  const newsCap = Math.max(0, opts.newsSlots);
  const contCap = Math.max(0, opts.continuationSlots);
  for (const hit of news) {
    if (selected.length >= opts.maxSymbols) break;
    if (seen.has(hit.symbol)) continue;
    if ([...selected].filter(s => s.track === 'news_gap').length >= newsCap) break;
    selected.push(hit);
    seen.add(hit.symbol);
  }
  for (const hit of continuation) {
    if (selected.length >= opts.maxSymbols) break;
    if (seen.has(hit.symbol)) continue;
    if ([...selected].filter(s => s.track === 'continuation').length >= contCap) {
      continue;
    }
    selected.push(hit);
    seen.add(hit.symbol);
  }

  return selected.slice(0, opts.maxSymbols);
}

export function moversToGapHoldWatchlist(
  movers: readonly OpeningMover[],
): WatchlistSymbol[] {
  return movers.map(m => ({
    symbol: m.symbol,
    origin: 'V2_PLAYMAKER' as const,
    source: 'satellite' as const,
    lastClose: m.last > 0 ? m.last : undefined,
    lastOpen: m.sessionOpen > 0 ? m.sessionOpen : undefined,
    previousClose: m.previousClose > 0 ? m.previousClose : undefined,
    previousHigh: m.previousHigh !== null && m.previousHigh > 0 ? m.previousHigh : undefined,
    dollarVolume: m.rthDollarVolume > 0 ? m.rthDollarVolume : undefined,
    preMarketGapPct: m.overnightGapPct ?? undefined,
    gapUp: m.overnightGapPct ?? undefined,
  }));
}

export async function scanGapHoldUniverse(
  pool: readonly EligiblePoolEntry[],
  client: SnapshotClient,
  opts: GapHoldScannerOpts,
): Promise<OpeningMover[]> {
  const hits = await collectSnapshotMovers(pool, client);
  const selected = rankGapHoldMovers(hits, opts);
  const newsN = selected.filter(m => m.track === 'news_gap').length;
  const contN = selected.filter(m => m.track === 'continuation').length;
  log.info(
    `Scan ${hits.length} prints → ${selected.length} movers ` +
    `(news ${newsN}, continuation ${contN}, pinned ${opts.pinned.size})`,
  );
  selected.slice(0, 12).forEach(m => {
    if (m.last <= 0) return;
    const gap = m.overnightGapPct;
    log.info(
      `  ${m.symbol.padEnd(6)} | ${(m.track ?? 'pinned').padEnd(12)} ` +
      `| overnight ${gap === null ? 'N/A' : `${(gap * 100).toFixed(1)}%`} ` +
      `| last $${m.last.toFixed(2)} open $${m.sessionOpen.toFixed(2)}` +
      (opts.pinned.has(m.symbol) ? ' | pinned' : ''),
    );
  });
  return selected;
}

export interface GapHoldCatalystCache {
  get(symbol: string): CatalystAssessment | undefined;
  set(symbol: string, value: CatalystAssessment): void;
}

/**
 * News track must print a bullish headline and no bearish one (TYRA veto).
 * Continuation and pinned names pass through. Fail closed on fetch errors.
 */
export async function filterNewsGapMovers(
  movers: readonly OpeningMover[],
  provider: NewsProvider,
  cache: GapHoldCatalystCache,
  opts: { lookbackHours: number; concurrency: number },
): Promise<OpeningMover[]> {
  const lookbackMs = opts.lookbackHours * 60 * 60 * 1000;
  const end = new Date();
  const start = new Date(end.getTime() - lookbackMs);
  const kept: OpeningMover[] = [];

  const pending = movers.filter(m => m.track === 'news_gap');
  const passThrough = movers.filter(m => m.track !== 'news_gap');
  kept.push(...passThrough);

  for (let i = 0; i < pending.length; i += opts.concurrency) {
    const batch = pending.slice(i, i + opts.concurrency);
    const assessed = await Promise.all(batch.map(async mover => {
      const cached = cache.get(mover.symbol);
      if (cached !== undefined) return { mover, assessment: cached };
      try {
        const headlines = await provider.getHeadlines(mover.symbol, start, end);
        const assessment = assessStrictBullishCatalyst(headlines);
        cache.set(mover.symbol, assessment);
        return { mover, assessment };
      } catch (err: unknown) {
        log.warn(`${mover.symbol} news fetch failed — ${toErrorMessage(err)}`);
        const assessment: CatalystAssessment = {
          passes: false,
          sentiment: 'NEUTRAL',
          catalystScore: 0,
          catalystHeadline: null,
          headlineCount: 0,
        };
        cache.set(mover.symbol, assessment);
        return { mover, assessment };
      }
    }));

    for (const { mover, assessment } of assessed) {
      if (!assessment.passes) {
        log.info(
          `${mover.symbol} DROP news_gap — catalyst ${assessment.sentiment} ` +
          `(headlines=${assessment.headlineCount})`,
        );
        continue;
      }
      log.info(
        `${mover.symbol} KEEP news_gap — "${(assessment.catalystHeadline ?? '').slice(0, 80)}"`,
      );
      kept.push(mover);
    }
  }

  return kept;
}
