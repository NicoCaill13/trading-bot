/**
 * Rebuilds the pre-market watchlist for a past session, from historical bars.
 *
 * Mirrors premarket_screener.ts filter order — price band, gap, pre-market share
 * volume, then the size cap — but sources everything from bars so a completed
 * session can be reconstructed exactly. The live screener reads snapshots, which
 * only exist in the present.
 */

import config from '../../src/config';
import { nyWallTimeToUtc } from '../../src/utils';
import { comparePremarketRank, passesPremarketPricePair } from '../../src/screenerMath';
import { fetchBars, type Feed, type RawBar } from './barFetch';

/** 30-min bars align on :00/:30, so [04:00, 09:30) never spills into RTH. */
const PREMARKET_TIMEFRAME = '30Min';
const PREV_CLOSE_LOOKBACK_DAYS = 8;

export interface Candidate {
  symbol: string;
  gapPct: number;
  premarketVolume: number;
  premarketPrice: number;
  previousClose: number;
}

export interface FunnelStages {
  hadPremarketData: number;
  passedPriceBand: number;
  passedGap: number;
  passedVolume: number;
}

export interface SessionFunnel {
  session: string;
  stages: FunnelStages;
  /** Passing candidates, ranked by pre-market dollar volume and capped like the live screener. */
  watchlist: Candidate[];
}

export function sessionWindow(session: string): { start: Date; end: Date } {
  const [year, month, day] = session.split('-').map(Number);
  const estDay = new Date(year, month - 1, day);
  return {
    start: nyWallTimeToUtc(estDay, 4, 0),
    end: nyWallTimeToUtc(estDay, 9, 30),
  };
}

function lastCloseBefore(bars: RawBar[], cutoffMs: number): number | null {
  let close: number | null = null;
  for (const bar of bars) {
    if (Date.parse(bar.t) >= cutoffMs) break;
    close = bar.c;
  }
  return close;
}

export async function buildSessionFunnel(
  universe: readonly string[],
  session: string,
  feed: Feed,
): Promise<SessionFunnel> {
  const { start, end } = sessionWindow(session);
  const dailyStart = new Date(start.getTime() - PREV_CLOSE_LOOKBACK_DAYS * 86_400_000);

  const [dailyBars, premarketBars] = await Promise.all([
    fetchBars(universe, '1Day', dailyStart, start, feed),
    fetchBars(universe, PREMARKET_TIMEFRAME, start, end, feed),
  ]);

  const minGap = config.premarket.minGapUpPct;
  const minShares = config.premarket.minPreMarketShareVolume;
  const minPrice = config.screener.minClosePrice;
  const maxPrice = config.screener.maxClosePrice;

  const stages: FunnelStages = {
    hadPremarketData: 0,
    passedPriceBand: 0,
    passedGap: 0,
    passedVolume: 0,
  };
  const passing: Candidate[] = [];

  for (const [symbol, bars] of premarketBars) {
    const inWindow = bars.filter(b => {
      const ts = Date.parse(b.t);
      return ts >= start.getTime() && ts < end.getTime();
    });
    if (inWindow.length === 0) continue;
    stages.hadPremarketData++;

    const premarketPrice = inWindow[inWindow.length - 1].c;
    const previousClose = lastCloseBefore(dailyBars.get(symbol) ?? [], start.getTime());
    if (previousClose === null || previousClose <= 0) continue;

    if (!passesPremarketPricePair(premarketPrice, previousClose, minPrice, maxPrice)) continue;
    stages.passedPriceBand++;

    const gapPct = (premarketPrice - previousClose) / previousClose;
    if (minGap > 0 && gapPct < minGap) continue;
    stages.passedGap++;

    const premarketVolume = inWindow.reduce((sum, b) => sum + b.v, 0);
    if (premarketVolume < minShares) continue;
    stages.passedVolume++;

    passing.push({ symbol, gapPct, premarketVolume, premarketPrice, previousClose });
  }

  passing.sort((a, b) =>
    comparePremarketRank(
      { dollarVolume: a.premarketPrice * a.premarketVolume, gapPct: a.gapPct },
      { dollarVolume: b.premarketPrice * b.premarketVolume, gapPct: b.gapPct },
    ),
  );

  return {
    session,
    stages,
    watchlist: passing.slice(0, config.premarket.watchlistMaxSize),
  };
}
