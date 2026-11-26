import config from './config';
import { createHeartbeatWriter } from './heartbeat';
import { createLogger } from './logger';
import { isTradingDay } from './marketCalendar';
import { alertCritical } from './notifier';
import { runSwingScan } from './screener';
import type { HeartbeatSnapshot, SessionPhase } from './types';
import {
  estCalendarDayKey,
  getESTDate,
  toErrorMessage,
  toZonedDate,
  zonedWallTimeToUtc,
} from './utils';

const log = createLogger('SYSTEM');

interface RuntimeState {
  startedAt: string;
  phase: SessionPhase;
  phaseSince: string;
  tradingDay: boolean;
  lastScanAt: string | null;
  reportTradingDay: string | null;
  candidateCount: number;
}

function parseArgs(argv: readonly string[]): { once: boolean; date: string | null } {
  let once = false;
  let date: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--once') once = true;
    if (arg === '--date') {
      date = argv[i + 1] ?? null;
      if (date === null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error('[SYSTEM] --date expects YYYY-MM-DD');
      }
      i++;
    }
  }
  return { once: once || date !== null, date };
}

function nextScanInstant(fromMs: number): Date {
  const zone = config.schedule.timeZone;
  const wall = toZonedDate(new Date(fromMs), zone);
  let when = zonedWallTimeToUtc(wall, config.schedule.hour, config.schedule.minute, zone);
  if (when.getTime() <= fromMs) {
    const tomorrow = new Date(wall.getTime());
    tomorrow.setDate(tomorrow.getDate() + 1);
    when = zonedWallTimeToUtc(tomorrow, config.schedule.hour, config.schedule.minute, zone);
  }
  return when;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const state: RuntimeState = {
    startedAt: new Date().toISOString(),
    phase: 'idle',
    phaseSince: new Date().toISOString(),
    tradingDay: false,
    lastScanAt: null,
    reportTradingDay: null,
    candidateCount: 0,
  };

  const setPhase = (phase: SessionPhase): void => {
    if (state.phase === phase) return;
    state.phase = phase;
    state.phaseSince = new Date().toISOString();
  };

  const heartbeat = createHeartbeatWriter(
    config.paths.heartbeat,
    config.health.heartbeatIntervalMs,
    (): HeartbeatSnapshot => ({
      writtenAt: new Date().toISOString(),
      startedAt: state.startedAt,
      pid: process.pid,
      sessionPhase: state.phase,
      sessionPhaseSince: state.phaseSince,
      tradingDay: state.tradingDay,
      lastScanAt: state.lastScanAt,
      reportTradingDay: state.reportTradingDay,
      candidateCount: state.candidateCount,
    }),
  );
  heartbeat.start();

  const scan = async (date: string | null): Promise<void> => {
    setPhase('scanning');
    const report = await runSwingScan(date ?? undefined);
    state.lastScanAt = new Date().toISOString();
    state.reportTradingDay = report.tradingDay;
    state.candidateCount = report.cards.length;
    state.tradingDay = true;
    setPhase('idle');
  };

  if (args.once) {
    try {
      await scan(args.date);
    } catch (err) {
      const message = toErrorMessage(err);
      log.error(message);
      await alertCritical('Radar swing', message);
      heartbeat.stop();
      process.exitCode = 1;
      return;
    }
    heartbeat.stop();
    return;
  }

  log.info(
    `Swing study radar scheduled at ` +
    `${String(config.schedule.hour).padStart(2, '0')}:` +
    `${String(config.schedule.minute).padStart(2, '0')} ${config.schedule.timeZone}`,
  );

  for (;;) {
    const when = nextScanInstant(Date.now());
    const waitMs = Math.max(0, when.getTime() - Date.now());
    log.info(`Next scan at ${when.toISOString()} (in ${Math.round(waitMs / 60000)} min)`);
    await sleep(waitMs);

    const trading = await isTradingDay();
    state.tradingDay = trading;
    if (!trading) {
      setPhase('non_trading_day');
      log.info(`Market closed on ${estCalendarDayKey(getESTDate())} — scan skipped`);
      setPhase('idle');
      await sleep(60_000);
      continue;
    }

    try {
      await scan(null);
    } catch (err) {
      const message = toErrorMessage(err);
      log.error(message);
      await alertCritical('Radar swing', message);
      setPhase('idle');
      await sleep(60_000);
    }
  }
}

void main();
