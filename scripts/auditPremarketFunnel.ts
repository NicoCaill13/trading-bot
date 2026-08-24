/**
 * Diagnostic: replays the pre-market screener funnel over recent sessions and
 * counts how many candidates each filter leaves, once per data feed.
 *
 * Answers a single question before a live session test: does the current
 * threshold set produce candidates at all, and how much of the gap between
 * "no candidates" and "candidates" is explained by the IEX feed alone.
 *
 * Run: npx tsx scripts/auditPremarketFunnel.ts [sessions]
 */

import config from '../src/config';
import { getDynamicUniverse } from '../src/screener';
import { fetchRecentSessions, type Feed } from './lib/barFetch';
import { buildSessionFunnel } from './lib/premarketFunnel';

const SESSIONS_TO_AUDIT = Number(process.argv[2] ?? 5);
const FEEDS: readonly Feed[] = ['iex', 'sip'];
const TOP_CANDIDATES_SHOWN = 5;

async function main(): Promise<void> {
  const universe = await getDynamicUniverse();
  const sessions = await fetchRecentSessions(SESSIONS_TO_AUDIT);

  console.log(
    `\nUniverse ${universe.length} symbols | sessions ${sessions.join(', ')}\n` +
    `Thresholds: price $${config.screener.minClosePrice}-$${config.screener.maxClosePrice} | ` +
    `gap >= ${(config.premarket.minGapUpPct * 100).toFixed(0)}% | ` +
    `pre-market volume >= ${(config.premarket.minPreMarketShareVolume / 1e6).toFixed(1)}M shares\n`,
  );

  for (const session of sessions) {
    console.log(`── ${session} ${'─'.repeat(56)}`);

    for (const feed of FEEDS) {
      const { stages, watchlist } = await buildSessionFunnel(universe, session, feed);

      console.log(
        `  ${feed.toUpperCase().padEnd(4)} ` +
        `pm-data ${String(stages.hadPremarketData).padStart(5)} → ` +
        `price-band ${String(stages.passedPriceBand).padStart(4)} → ` +
        `gap ${String(stages.passedGap).padStart(4)} → ` +
        `volume ${String(stages.passedVolume).padStart(3)}  ` +
        `[WATCHLIST: ${watchlist.length}]`,
      );

      for (const c of watchlist.slice(0, TOP_CANDIDATES_SHOWN)) {
        console.log(
          `         ${c.symbol.padEnd(6)} $${c.premarketPrice.toFixed(2).padStart(6)} ` +
          `gap ${(c.gapPct * 100).toFixed(1).padStart(6)}% ` +
          `vol ${(c.premarketVolume / 1e6).toFixed(2)}M`,
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
