/**
 * Escalation policy — "when to speak", kept separate from "what is wrong"
 * (watchdogRules) and from the process wiring (watchdog).
 *
 * Pure and clock-injected so the notification cadence is unit-testable.
 */

const REMINDER_DELAYS_MS: readonly number[] = [
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
];

export interface AlertState {
  notificationsSent: number;
  lastNotifiedAtMs: number;
  firstSeenAtMs: number;
}

/**
 * Delay before the next reminder, given how many notifications already went out.
 * Grows then caps, so a multi-hour outage cannot flood the channel.
 */
export function nextReminderDelayMs(notificationsSent: number): number {
  const index = Math.min(
    Math.max(notificationsSent - 1, 0),
    REMINDER_DELAYS_MS.length - 1,
  );
  return REMINDER_DELAYS_MS[index];
}

/** A brand-new finding is always announced; a known one waits for its slot. */
export function shouldNotify(state: AlertState | undefined, nowMs: number): boolean {
  if (state === undefined) return true;
  return nowMs >= state.lastNotifiedAtMs + nextReminderDelayMs(state.notificationsSent);
}

export function registerNotification(
  state: AlertState | undefined,
  nowMs: number,
): AlertState {
  if (state === undefined) {
    return { notificationsSent: 1, lastNotifiedAtMs: nowMs, firstSeenAtMs: nowMs };
  }
  return {
    notificationsSent: state.notificationsSent + 1,
    lastNotifiedAtMs: nowMs,
    firstSeenAtMs: state.firstSeenAtMs,
  };
}

export function formatIncidentDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}`;
}
