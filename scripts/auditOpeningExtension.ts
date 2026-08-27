/**
 * Replay the opening-extension ranker over 25–27 Aug 2026 on the IEX tape.
 *
 * SIP recent history 403s on this account; dollar-volume floors are therefore
 * IEX-scale. Ranking in percent is feed-agnostic.
 *
 * Run: npx tsx scripts/auditOpeningExtension.ts [YYYY-MM-DD ...]
 */

import config from '../src/config';
import { getDynamicUniverse } from '../src/screener';
import {
  compareOpeningExtensionRank,
  computeOpeningExtensionPct,
  passesDollarVolume,
  passesOpeningExtensionGates,
  passesPremarketPricePair,
} from '../src/screenerMath';
import { nyWallTimeToUtc, toESTDate } from '../src/utils';
import type { OpeningMover } from '../src/openingScanner';
import { rankOpeningMovers } from '../src/openingScanner';
import { fetchBars, type RawBar } from './lib/barFetch';

const DEFAULT_SESSIONS = ['2026-08-25', '2026-08-26', '2026-08-27'];
const SESSIONS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_SESSIONS;
const FEED = 'iex' as const;
const SNAPSHOT_MINUTES = [9 * 60 + 31, 9 * 60 + 45] as const;
const PREV_CLOSE_LOOKBACK_DAYS = 8;

/** Names the 09:15 gap/$vol list missed this week. */
const EXPECTED_MOVERS = [
  'MRNA', 'SMCI', 'CRSP', 'MARA', 'SLDB', 'FUBO', 'ANF', 'CLSK', 'PATH', 'ASAN', 'WULF',
] as const;

/** What the 09:15 list actually watched. */
const DISTRACTORS = ['INTC', 'TQQQ', 'SQQQ', 'AAL'] as const;

const ALWAYS_FETCH = [...new Set([...EXPECTED_MOVERS, ...DISTRACTORS])];

function estDay(session: string): Date {
  const [year, month, day] = session.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function lastDailyBefore(
  bars: readonly RawBar[],
  cutoffMs: number,
): { close: number; volume: number } | null {
  let found: RawBar | null = null;
  for (const bar of bars) {
    if (Date.parse(bar.t) >= cutoffMs) break;
    found = bar;
  }
  if (found === null || !(found.c > 0)) return null;
  return { close: found.c, volume: found.v };
}

function barMinutes(timestamp: string): number {
  const est = toESTDate(new Date(timestamp));
  return est.getHours() * 60 + est.getMinutes();
}

function moverAtSnapshot(
  symbol: string,
  bars: readonly RawBar[],
  previousClose: number,
  snapshotMinutes: number,
  marketOpenMinutes: number,
): OpeningMover | null {
  const inWindow = bars.filter(b => {
    const mins = barMinutes(b.t);
    return mins >= marketOpenMinutes && mins <= snapshotMinutes;
  });
  if (inWindow.length === 0) return null;
  const sessionOpen = inWindow[0].o;
  const last = inWindow[inWindow.length - 1].c;
  const extensionPct = computeOpeningExtensionPct(last, sessionOpen);
  if (extensionPct === null) return null;
  const rthShares = inWindow.reduce((sum, b) => sum + b.v, 0);
  return {
    symbol,
    last,
    sessionOpen,
    previousClose,
    rthDollarVolume: last * rthShares,
    extensionPct,
  };
}

function fmtPct(value: number): string {
  return `${(value * 100).toFixed(1).padStart(6)}%`;
}

function fmtUsd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${Math.round(value / 1_000)}k`;
  return `$${Math.round(value)}`;
}

async function main(): Promise<void> {
  const od = config.openingDrive;
  const minPrice = config.screener.minClosePrice;
  const maxPrice = config.screener.maxClosePrice;
  const marketOpenMinutes =
    config.session.marketOpenHour * 60 + config.session.marketOpenMinute;

  console.log(
    `\nOpening-extension audit | feed ${FEED.toUpperCase()} | sessions ${SESSIONS.join(', ')}\n` +
    `Pool: $${minPrice}–$${maxPrice}, prev $vol ≥ ${fmtUsd(config.premarket.poolMinPrevDollarVolume)}, ` +
    `cap ${config.premarket.poolMaxSize}\n` +
    `Scanner: ext ≥ ${(od.scannerMinExtensionPct * 100).toFixed(1)}%, ` +
    `RTH $vol ≥ ${fmtUsd(od.scannerMinRthDollarVolume)}, top ${od.scannerMaxSymbols}\n`,
  );

  const universe = await getDynamicUniverse();
  const seed = [...new Set([...universe, ...ALWAYS_FETCH])];

  const first = estDay(SESSIONS[0]);
  const last = estDay(SESSIONS[SESSIONS.length - 1]);
  const dailyStart = new Date(
    nyWallTimeToUtc(first, 4, 0).getTime() - PREV_CLOSE_LOOKBACK_DAYS * 86_400_000,
  );
  const dailyEnd = nyWallTimeToUtc(last, 9, 30);

  console.log(`Fetching 1Day ${FEED} for ${seed.length} symbols...`);
  const dailyBars = await fetchBars(seed, '1Day', dailyStart, dailyEnd, FEED);

  for (const session of SESSIONS) {
    const day = estDay(session);
    const poolCutoff = nyWallTimeToUtc(day, 0, 0);
    const rthStart = nyWallTimeToUtc(day, 9, 30);
    const rthEnd = nyWallTimeToUtc(day, 10, 0);

    const pool: { symbol: string; previousClose: number; prevDollarVolume: number }[] = [];
    for (const symbol of seed) {
      const prev = lastDailyBefore(dailyBars.get(symbol) ?? [], poolCutoff.getTime());
      if (prev === null) continue;
      if (!passesPremarketPricePair(prev.close, prev.close, minPrice, maxPrice)) continue;
      if (!passesDollarVolume(prev.close, prev.volume, config.premarket.poolMinPrevDollarVolume)) {
        continue;
      }
      pool.push({
        symbol,
        previousClose: prev.close,
        prevDollarVolume: prev.close * prev.volume,
      });
    }
    pool.sort((a, b) => b.prevDollarVolume - a.prevDollarVolume);
    const capped = pool.slice(0, config.premarket.poolMaxSize);
    const scanSymbols = [...new Set([...capped.map(p => p.symbol), ...ALWAYS_FETCH])];

    console.log(`── ${session} ${'─'.repeat(56)}`);
    console.log(
      `  pool ${capped.length}/${pool.length} eligible | 1Min fetch ${scanSymbols.length}`,
    );

    const oneMin = await fetchBars(scanSymbols, '1Min', rthStart, rthEnd, FEED);
    const prevClose = new Map<string, number>();
    for (const symbol of scanSymbols) {
      const prev = lastDailyBefore(dailyBars.get(symbol) ?? [], poolCutoff.getTime());
      if (prev !== null) prevClose.set(symbol, prev.close);
    }

    for (const snapshotMinutes of SNAPSHOT_MINUTES) {
      const hits: OpeningMover[] = [];
      for (const symbol of scanSymbols) {
        const previousClose = prevClose.get(symbol);
        if (previousClose === undefined) continue;
        const mover = moverAtSnapshot(
          symbol,
          oneMin.get(symbol) ?? [],
          previousClose,
          snapshotMinutes,
          marketOpenMinutes,
        );
        if (mover !== null) hits.push(mover);
      }

      const selected = rankOpeningMovers(hits, {
        minPrice,
        maxPrice,
        minExtensionPct: od.scannerMinExtensionPct,
        minRthDollarVolume: od.scannerMinRthDollarVolume,
        maxSymbols: od.scannerMaxSymbols,
        pinned: new Set(),
      });

      const hh = String(Math.floor(snapshotMinutes / 60)).padStart(2, '0');
      const mm = String(snapshotMinutes % 60).padStart(2, '0');
      const expectedInTop = EXPECTED_MOVERS.filter(s => selected.some(m => m.symbol === s));
      console.log(
        `  ${hh}:${mm}  gated ${hits.filter(h =>
          passesOpeningExtensionGates(
            {
              last: h.last,
              sessionOpen: h.sessionOpen,
              previousClose: h.previousClose,
              rthDollarVolume: h.rthDollarVolume,
            },
            {
              minPrice,
              maxPrice,
              minExtensionPct: od.scannerMinExtensionPct,
              minRthDollarVolume: od.scannerMinRthDollarVolume,
            },
          ),
        ).length} → top ${selected.length} | expected in top: ` +
        `${expectedInTop.length > 0 ? expectedInTop.join(', ') : '(none)'}`,
      );

      for (const m of selected.slice(0, 12)) {
        const tag = EXPECTED_MOVERS.includes(m.symbol as typeof EXPECTED_MOVERS[number])
          ? ' *'
          : DISTRACTORS.includes(m.symbol as typeof DISTRACTORS[number])
            ? ' !'
            : '  ';
        console.log(
          `         ${tag} ${m.symbol.padEnd(6)} ${fmtPct(m.extensionPct)} ` +
          `open $${m.sessionOpen.toFixed(2).padStart(7)} last $${m.last.toFixed(2).padStart(7)} ` +
          `$vol ${fmtUsd(m.rthDollarVolume).padStart(8)}`,
        );
      }

      console.log('         expected / distractors:');
      const tracked = [...EXPECTED_MOVERS, ...DISTRACTORS];
      const rankedAll = [...hits].sort(compareOpeningExtensionRank);
      for (const symbol of tracked) {
        const mover = hits.find(h => h.symbol === symbol);
        if (mover === undefined) {
          console.log(`           ${symbol.padEnd(6)} no IEX 1Min in window`);
          continue;
        }
        const gated = passesOpeningExtensionGates(
          {
            last: mover.last,
            sessionOpen: mover.sessionOpen,
            previousClose: mover.previousClose,
            rthDollarVolume: mover.rthDollarVolume,
          },
          {
            minPrice,
            maxPrice,
            minExtensionPct: od.scannerMinExtensionPct,
            minRthDollarVolume: od.scannerMinRthDollarVolume,
          },
        );
        const rank = rankedAll.findIndex(h => h.symbol === symbol) + 1;
        const reasons: string[] = [];
        if (!(mover.last > mover.sessionOpen)) reasons.push('not-above-open');
        if (mover.extensionPct < od.scannerMinExtensionPct) reasons.push('ext');
        if (!passesPremarketPricePair(mover.last, mover.previousClose, minPrice, maxPrice)) {
          reasons.push('price-band');
        }
        if (mover.rthDollarVolume < od.scannerMinRthDollarVolume) reasons.push('rth-$vol');
        console.log(
          `           ${symbol.padEnd(6)} rank ${String(rank).padStart(4)} ` +
          `${fmtPct(mover.extensionPct)} $vol ${fmtUsd(mover.rthDollarVolume).padStart(8)} ` +
          (gated ? 'PASS' : `FAIL ${reasons.join(',')}`),
        );
      }
    }
    console.log('');
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
