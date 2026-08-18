import { createLogger } from './logger';
import { readHeartbeat } from './heartbeat';
import { evaluateHeartbeat, suppressDuringStartupGrace } from './watchdogRules';
import {
  formatIncidentDuration,
  registerNotification,
  shouldNotify,
  type AlertState,
} from './watchdogEscalation';
import { sendTelegramMessage, type TelegramCredentials } from './telegramClient';
import {
  estCalendarDayKey,
  getESTDate,
  minutesSinceMidnight,
  toErrorMessage,
} from './utils';
import { optionalEnv, parseIntEnv, parseStringEnv } from './env';
import type { WatchdogFinding, WatchdogFindingCode, WatchdogThresholds } from './types';

/**
 * Standalone liveness watchdog.
 *
 * Runs as a sibling process to the bot and deliberately imports no trading
 * config, no broker client and no strategy code: a watchdog that shares its
 * subject's failure modes is not a watchdog. Its only input is the heartbeat
 * file, and it holds no broker credentials — it reports, it never acts.
 */

const log = createLogger('WATCHDOG');

interface DigestSlot {
  label: string;
  minutes: number;
}

function parseDigestSlot(label: string, raw: string): DigestSlot {
  const [hourPart, minutePart] = raw.split(':');
  const hour = Number(hourPart);
  const minute = Number(minutePart);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error(`[WATCHDOG] Invalid digest time for ${label}: "${raw}" (expected HH:MM)`);
  }
  return { label, minutes: hour * 60 + minute };
}

const heartbeatPath = parseStringEnv('HEARTBEAT_PATH', './data/heartbeat.json');
const pollIntervalMs = parseIntEnv('WATCHDOG_POLL_INTERVAL_MS', 30_000);

// Both systemd units start together after a reboot: give the bot time to boot
// before concluding it is dead.
const startupGraceMs = parseIntEnv('WATCHDOG_STARTUP_GRACE_MS', 120_000);
const watchdogStartedAtMs = Date.now();

const thresholds: WatchdogThresholds = {
  heartbeatStaleMs: parseIntEnv('WATCHDOG_HEARTBEAT_STALE_MS', 120_000),
  marketDataStaleMs: parseIntEnv('WATCHDOG_MARKET_DATA_STALE_MS', 180_000),
  watchlistMaxAgeHours: parseIntEnv('WATCHDOG_WATCHLIST_MAX_AGE_HOURS', 96),
  openPositionCheckHour: parseIntEnv('WATCHDOG_OPEN_POSITION_CHECK_HOUR', 16),
  openPositionCheckMinute: parseIntEnv('WATCHDOG_OPEN_POSITION_CHECK_MINUTE', 5),
  openPositionDataMaxAgeMs: parseIntEnv('WATCHDOG_POSITION_DATA_MAX_AGE_MS', 600_000),
};

const digestSlots: readonly DigestSlot[] = [
  parseDigestSlot('ouverture', parseStringEnv('WATCHDOG_DIGEST_OPEN', '09:35')),
  parseDigestSlot('clôture', parseStringEnv('WATCHDOG_DIGEST_CLOSE', '16:10')),
];

const credentials: TelegramCredentials = {
  token: optionalEnv('TELEGRAM_BOT_TOKEN'),
  chatId: optionalEnv('TELEGRAM_CHAT_ID'),
};

const telegramConfigured = credentials.token !== null && credentials.chatId !== null;

const activeAlerts = new Map<WatchdogFindingCode, AlertState>();
const sentDigestKeys = new Set<string>();

async function notify(message: string): Promise<void> {
  // Absence of credentials is reported once at startup; findings always reach
  // the log file, so there is nothing to warn about on every single check.
  if (!telegramConfigured) return;

  const result = await sendTelegramMessage(credentials, message);
  if (!result.delivered) {
    log.warn(`Telegram delivery failed: ${result.reason}`);
  }
}

async function reportFinding(finding: WatchdogFinding, nowMs: number): Promise<void> {
  const previous = activeAlerts.get(finding.code);
  if (!shouldNotify(previous, nowMs)) return;

  const updated = registerNotification(previous, nowMs);
  activeAlerts.set(finding.code, updated);

  const isFirst = previous === undefined;
  const since = isFirst
    ? ''
    : ` (depuis ${formatIncidentDuration(nowMs - updated.firstSeenAtMs)})`;

  log.error(`${finding.code}${since} — ${finding.message}`);
  await notify(`🔴 <b>[WATCHDOG] ${finding.code}</b>${since}\n${finding.message}`);
}

async function reportRecoveries(
  activeCodes: ReadonlySet<WatchdogFindingCode>,
  nowMs: number,
): Promise<void> {
  for (const [code, state] of [...activeAlerts.entries()]) {
    if (activeCodes.has(code)) continue;
    activeAlerts.delete(code);
    const duration = formatIncidentDuration(nowMs - state.firstSeenAtMs);
    log.info(`${code} resolved after ${duration}`);
    await notify(`🟢 <b>[WATCHDOG] ${code} résolu</b>\nDurée de l'incident : ${duration}`);
  }
}

/**
 * A watchdog that only speaks on failure makes silence ambiguous: a dead
 * watchdog and a healthy system look identical. Scheduled digests make
 * "no news" verifiable.
 */
async function maybeSendDigest(estNow: Date, healthy: boolean): Promise<void> {
  const estDay = estCalendarDayKey(estNow);
  const nowMinutes = minutesSinceMidnight(estNow);

  for (const slot of digestSlots) {
    if (nowMinutes < slot.minutes) continue;
    const key = `${estDay}:${slot.label}`;
    if (sentDigestKeys.has(key)) continue;
    sentDigestKeys.add(key);

    const status = healthy
      ? '🟢 Aucun incident'
      : `🔴 Incident(s) en cours : ${[...activeAlerts.keys()].join(', ')}`;
    await notify(`🩺 <b>[WATCHDOG] Contrôle ${slot.label}</b>\n${status}`);
  }
}

async function runCheck(): Promise<void> {
  const now = new Date();
  const nowMs = now.getTime();

  const snapshot = readHeartbeat(heartbeatPath);
  const findings = suppressDuringStartupGrace(
    evaluateHeartbeat(snapshot, now, thresholds),
    nowMs - watchdogStartedAtMs,
    startupGraceMs,
  );
  const activeCodes = new Set<WatchdogFindingCode>(findings.map(f => f.code));

  for (const finding of findings) {
    await reportFinding(finding, nowMs);
  }
  await reportRecoveries(activeCodes, nowMs);
  await maybeSendDigest(getESTDate(), findings.length === 0);
}

function startLoop(): void {
  const tick = (): void => {
    runCheck().catch((err: unknown) => {
      // The watchdog must outlive every transient failure it observes.
      log.error(`Check failed: ${toErrorMessage(err)}`);
    });
  };

  tick();
  setInterval(tick, pollIntervalMs);
}

async function main(): Promise<void> {
  if (thresholds.heartbeatStaleMs <= pollIntervalMs) {
    throw new Error(
      `[WATCHDOG] WATCHDOG_HEARTBEAT_STALE_MS (${thresholds.heartbeatStaleMs}) must exceed ` +
      `WATCHDOG_POLL_INTERVAL_MS (${pollIntervalMs})`,
    );
  }

  log.info(
    `Watchdog started — heartbeat ${heartbeatPath} | poll ${Math.round(pollIntervalMs / 1000)}s | ` +
    `heartbeat stale ${Math.round(thresholds.heartbeatStaleMs / 1000)}s | ` +
    `bar stale ${Math.round(thresholds.marketDataStaleMs / 1000)}s | ` +
    `startup grace ${Math.round(startupGraceMs / 1000)}s`,
  );

  if (!telegramConfigured) {
    log.warn('Telegram credentials missing — findings will only reach the log file');
  }

  startLoop();
  await Promise.resolve();
}

process.on('SIGTERM', () => { process.exit(0); });
process.on('SIGINT', () => { process.exit(0); });

main().catch((err: unknown) => {
  log.error(`Fatal watchdog error: ${toErrorMessage(err)}`);
  process.exit(1);
});
