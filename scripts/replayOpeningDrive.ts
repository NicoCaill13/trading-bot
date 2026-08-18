/**
 * Throwaway calibration harness (#29): replays the Opening Drive decision over
 * real 1-min IEX bars, forcing the STRAIGHT_RUN tag so the path can be exercised
 * before tonight's screener writes it.
 *
 * Usage: npx tsx scripts/replayOpeningDrive.ts WDC 2026-08-17
 */

import alpaca from '../src/alpacaClient';
import config from '../src/config';
import { evaluateOpeningDrive, type OpeningDriveContext } from '../src/openingDrive';
import {
  applyBarToShadowRecord,
  createShadowRecord,
  isHorizonElapsed,
  summarizeShadowRecord,
} from '../src/shadowJournal';
import { minutesSinceMidnight } from '../src/vwapSetup';
import { toESTDate } from '../src/utils';
import type { BarData, ShadowSignalRecord } from '../src/types';

const symbol = process.argv[2] ?? 'WDC';
const day = process.argv[3] ?? '2026-08-17';

const opts = {
  windowStartMinutes: config.openingDrive.windowStartHour * 60 + config.openingDrive.windowStartMinute,
  windowEndMinutes: config.openingDrive.windowEndHour * 60 + config.openingDrive.windowEndMinute,
  minRvol1m: config.openingDrive.minRvol1m,
  minImbalance: config.openingDrive.minImbalance,
  maxExtensionPct: config.openingDrive.maxExtensionPct,
  rvolBaselineBars: config.openingDrive.rvolBaselineBars,
  hardStopFloorPct: config.risk.hardStopFloorPct,
};

async function main(): Promise<void> {
  const bars: BarData[] = [];
  const iter = alpaca.getBarsV2(symbol, {
    start: `${day}T08:00:00Z`,
    end: `${day}T21:00:00Z`,
    timeframe: '1Min',
    feed: 'iex',
    limit: 1000,
  });

  for await (const b of iter) {
    bars.push({
      open: b.OpenPrice,
      high: b.HighPrice,
      low: b.LowPrice,
      close: b.ClosePrice,
      volume: b.Volume,
      timestamp: b.Timestamp,
    });
  }

  const openMinutes = config.session.marketOpenHour * 60 + config.session.marketOpenMinute;
  let sessionOpen: number | null = null;
  const history: BarData[] = [];
  const rth: BarData[] = [];

  const tally = new Map<string, number>();
  const observations = new Map<string, ShadowSignalRecord>();
  const verdicts: ShadowSignalRecord[] = [];
  let auditLogged = false;
  let armedLogged = false;
  let inWindow = 0;
  let surgeBars = 0;
  let minExt = Infinity;
  let maxExt = -Infinity;

  console.log(`${symbol} ${day} — ${bars.length} 1-min bar(s)`);

  for (const bar of bars) {
    const est = toESTDate(new Date(bar.timestamp));
    const minutes = minutesSinceMidnight(est);
    history.push(bar);
    if (history.length > 30) history.splice(0, history.length - 30);

    // Same ordering as the live hook: a bar updates observations opened earlier
    // before it can open one of its own.
    for (const [key, rec] of observations) {
      if (isHorizonElapsed(rec, bar)) {
        verdicts.push(rec);
        observations.delete(key);
        continue;
      }
      observations.set(key, applyBarToShadowRecord(rec, bar));
    }

    if (minutes < openMinutes) continue;
    if (sessionOpen === null) {
      sessionOpen = bar.open;
      console.log(
        `  session open $${sessionOpen.toFixed(2)} at ` +
        `${String(minutes / 60 | 0).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} EST`,
      );
    }
    rth.push(bar);

    const totalVol = rth.reduce((s, b) => s + b.volume, 0);
    const vwap = totalVol > 0
      ? rth.reduce((s, b) => s + ((b.high + b.low + b.close) / 3) * b.volume, 0) / totalVol
      : null;

    const ctx: OpeningDriveContext = {
      symbol,
      barMinutesSinceMidnight: minutes,
      isStraightRun: true,
      straightRunScore: 0.8,
      previousClose: null,
      sessionOpen,
      sessionVwap: vwap,
      impulseBar: bar,
      oneMinBars: history,
      imbalance: null,
    };

    const d = evaluateOpeningDrive(ctx, opts);
    if (d.rejection === 'outside_window') continue;

    inWindow++;
    tally.set(d.rejection ?? 'ARMED', (tally.get(d.rejection ?? 'ARMED') ?? 0) + 1);
    if (d.extensionPct !== null) {
      minExt = Math.min(minExt, d.extensionPct);
      maxExt = Math.max(maxExt, d.extensionPct);
    }
    if (d.rvol1m !== null && d.rvol1m > opts.minRvol1m) surgeBars++;

    if (d.rejection === 'no_momentum') continue;

    if (d.armed || d.rejection === 'max_extension') {
      const rejectedBy = d.armed ? null : 'max_extension';
      // Mirrors the live gates: one arm per symbol per session, and one audited
      // cap rejection. Observing every qualifying bar would overstate the number
      // of trades the bot actually takes.
      const isFirst = d.armed ? !armedLogged : !auditLogged;
      if (isFirst) {
        if (d.armed) armedLogged = true;
        else auditLogged = true;
        observations.set(
          `${symbol}|${bar.timestamp}`,
          createShadowRecord({
            symbol,
            signalAt: bar.timestamp,
            decision: d,
            straightRunScore: ctx.straightRunScore,
            rejectedBy,
            horizonMinutes: config.openingDrive.shadowHorizonMinutes,
          }),
        );
      }
    }

    const clock = `${String(minutes / 60 | 0).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    console.log(
      `  ${clock} ${d.armed ? 'ARMED'.padEnd(20) : `rej ${d.rejection}`.padEnd(20)} ` +
      `close $${bar.close.toFixed(2)} ext ${d.extensionPct === null ? 'N/A' : `${(d.extensionPct * 100).toFixed(2)}%`} ` +
      `rvol ${d.rvol1m === null ? 'N/A' : `${d.rvol1m.toFixed(2)}x`} ` +
      `stop ${d.stopPrice === null ? 'N/A' : `$${d.stopPrice.toFixed(2)}`}`,
    );
  }

  console.log(
    `  in-window bars ${inWindow} | rvol>${opts.minRvol1m} on ${surgeBars} | ` +
    `extension ${(minExt * 100).toFixed(2)}%..${(maxExt * 100).toFixed(2)}% ` +
    `(cap ${(opts.maxExtensionPct * 100).toFixed(2)}%)`,
  );
  console.log(`  outcomes ${[...tally].map(([k, v]) => `${k}=${v}`).join(' ')}`);

  for (const rec of observations.values()) verdicts.push(rec);
  for (const rec of verdicts) {
    console.log(`  VERDICT ${summarizeShadowRecord(rec)}`);
  }

  const last = rth[rth.length - 1];
  if (sessionOpen !== null && last) {
    console.log(
      `  session: open $${sessionOpen.toFixed(2)} → close $${last.close.toFixed(2)} ` +
      `(${(((last.close - sessionOpen) / sessionOpen) * 100).toFixed(2)}%)`,
    );
  }
}

void main();
