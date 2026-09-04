/**
 * SIP previous-session dollar-volume funnel for the 09:15 eligible pool.
 *
 * Reports how many names survive candidate floors and whether known runners
 * (CHPT, MARA, RIOT, CLSK, CRCL) sit inside the kept set or get truncated by
 * a liquidity-desc top-N (the mega-cap bias). Overflow past the cap drops the
 * *most* liquid names first — the live pool is an eligibility list, not a
 * liquidity ranking.
 *
 * Run: npx tsx scripts/auditSipPool.ts [YYYY-MM-DD]
 *      npx tsx scripts/auditSipPool.ts [sessions]
 * Default: last 5 completed sessions.
 */

import config from '../src/config';
import { getDynamicUniverse } from '../src/screener';
import { dailyLiquidityBySymbol, fetchDailyBars } from '../src/dailyBars';
import { getPreviousTradingDay } from '../src/marketCalendar';
import { nyWallTimeToUtc } from '../src/utils';
import { fetchRecentSessions } from './lib/barFetch';

const DATE_ARG = process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
const COUNT_ARG = process.argv.find(a => /^\d+$/.test(a));
const FLOORS = [1_500_000, 5_000_000, 8_000_000, 20_000_000, 50_000_000] as const;
const CEILINGS = [0, 100_000_000, 500_000_000, 800_000_000] as const;
const CAPS = [1500, 2500, 4000] as const;
const RUNNERS = ['CHPT', 'MARA', 'RIOT', 'CLSK', 'CRCL', 'CIFR', 'GLXY', 'SNAP', 'SMR'] as const;
const MEGA = ['INTC', 'BAC', 'NFLX', 'HOOD', 'MSTR'] as const;

interface FloorRow {
  floor: number;
  pass: number;
  chpt: boolean;
  mara: boolean;
  riot: boolean;
  clsk: boolean;
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  return `$${Math.round(n).toLocaleString()}`;
}

function flag(yes: boolean): string {
  return yes ? 'Y' : '.';
}

async function auditSession(
  universe: readonly string[],
  session: string,
): Promise<FloorRow[]> {
  const previous = await getPreviousTradingDay(
    new Date(`${session}T12:00:00-04:00`),
  );
  if (previous === null) throw new Error(`no previous trading day for ${session}`);

  const [year, month, day] = session.split('-').map(Number);
  const estDay = new Date(year, month - 1, day);
  const start = nyWallTimeToUtc(new Date(year, month - 1, day - 10), 0, 0);
  const cutoff = nyWallTimeToUtc(estDay, 0, 0);

  console.log(
    `\nSIP pool audit — session ${session} (prev ${previous})\n` +
    `  universe ${universe.length} | price $${config.screener.minClosePrice}–$${config.screener.maxClosePrice}\n`,
  );

  const bars = await fetchDailyBars(universe, start, cutoff, 'sip');
  const daily = dailyLiquidityBySymbol(bars, cutoff.getTime());

  const inBand: { symbol: string; dv: number }[] = [];
  for (const [symbol, liq] of daily) {
    if (liq.previousClose < config.screener.minClosePrice) continue;
    if (liq.previousClose > config.screener.maxClosePrice) continue;
    inBand.push({ symbol, dv: liq.previousClose * liq.previousVolume });
  }
  inBand.sort((a, b) => b.dv - a.dv);

  console.log(`  price-band names with SIP daily: ${inBand.length}\n`);
  console.log('  floor         pass   CHPT MARA RIOT CLSK  mega-in-top1500');
  const floors: FloorRow[] = [];
  for (const floor of FLOORS) {
    const pass = inBand.filter(r => r.dv >= floor);
    const has = (sym: string): boolean => pass.some(r => r.symbol === sym);
    const megaInTop = pass.slice(0, 1500).filter(r => (MEGA as readonly string[]).includes(r.symbol)).length;
    floors.push({
      floor,
      pass: pass.length,
      chpt: has('CHPT'),
      mara: has('MARA'),
      riot: has('RIOT'),
      clsk: has('CLSK'),
    });
    console.log(
      `  ${fmtUsd(floor).padEnd(12)} ${String(pass.length).padStart(5)}   ` +
      `${flag(has('CHPT'))}    ${flag(has('MARA'))}    ${flag(has('RIOT'))}    ${flag(has('CLSK'))}   ${megaInTop}`,
    );
  }

  console.log('\n  cap @ $5M floor — runners rank (1 = most liquid):');
  const at5m = inBand.filter(r => r.dv >= 5_000_000);
  for (const cap of CAPS) {
    const keptAsc = [...at5m].sort((a, b) => a.dv - b.dv).slice(0, cap);
    const keptSet = new Set(keptAsc.map(r => r.symbol));
    const line = RUNNERS.map(sym => {
      const row = at5m.find(r => r.symbol === sym);
      if (!row) return `${sym}=out`;
      const rankDesc = at5m.findIndex(r => r.symbol === sym) + 1;
      return `${sym}${keptSet.has(sym) ? '' : '!drop'}#${rankDesc}`;
    }).join(' ');
    console.log(`  cap ${String(cap).padStart(4)} keep ${keptAsc.length}: ${line}`);
  }

  console.log('\n  ceiling @ $5M floor (0 = none):');
  for (const ceiling of CEILINGS) {
    const pass = at5m.filter(r => ceiling <= 0 || r.dv <= ceiling);
    const dropped = RUNNERS.filter(sym => {
      const row = at5m.find(r => r.symbol === sym);
      return row !== undefined && ceiling > 0 && row.dv > ceiling;
    });
    const megaKept = pass.filter(r => (MEGA as readonly string[]).includes(r.symbol)).length;
    console.log(
      `  ${ceiling <= 0 ? 'none'.padEnd(12) : fmtUsd(ceiling).padEnd(12)} ` +
      `keep ${String(pass.length).padStart(5)} mega ${megaKept}` +
      (dropped.length > 0 ? ` dropped ${dropped.join(',')}` : ''),
    );
  }

  console.log('\n  runner SIP $vol:');
  for (const sym of [...RUNNERS, ...MEGA]) {
    const row = inBand.find(r => r.symbol === sym);
    console.log(`    ${sym.padEnd(6)} ${row ? fmtUsd(row.dv) : 'not in band'}`);
  }

  return floors;
}

async function main(): Promise<void> {
  const sessions = DATE_ARG
    ? [DATE_ARG]
    : await fetchRecentSessions(Number(COUNT_ARG ?? 5));
  if (sessions.length === 0) throw new Error('no session');

  const universe = await getDynamicUniverse();
  const summaries: { session: string; floors: FloorRow[] }[] = [];

  for (const session of sessions) {
    try {
      const floors = await auditSession(universe, session);
      summaries.push({ session, floors });
    } catch (err: unknown) {
      console.log(
        `  ${session} SKIPPED — ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
      );
    }
  }

  if (summaries.length < 2) return;

  console.log('\n══ floor stability across sessions ════════════════');
  console.log('  session     $5M pass  CHPT MARA RIOT CLSK');
  for (const row of summaries) {
    const at5 = row.floors.find(f => f.floor === 5_000_000);
    if (at5 === undefined) continue;
    console.log(
      `  ${row.session}  ${String(at5.pass).padStart(7)}   ` +
      `${flag(at5.chpt)}    ${flag(at5.mara)}    ${flag(at5.riot)}    ${flag(at5.clsk)}`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
