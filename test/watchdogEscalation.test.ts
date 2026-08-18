import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatIncidentDuration,
  nextReminderDelayMs,
  registerNotification,
  shouldNotify,
  type AlertState,
} from '../src/watchdogEscalation';

const T0 = 1_700_000_000_000;

describe('nextReminderDelayMs', () => {
  it('escalates then caps at the longest delay', () => {
    assert.equal(nextReminderDelayMs(1), 5 * 60_000);
    assert.equal(nextReminderDelayMs(2), 15 * 60_000);
    assert.equal(nextReminderDelayMs(3), 30 * 60_000);
    assert.equal(nextReminderDelayMs(4), 60 * 60_000);
    assert.equal(nextReminderDelayMs(99), 60 * 60_000);
  });

  it('is defensive about a zero count', () => {
    assert.equal(nextReminderDelayMs(0), 5 * 60_000);
  });
});

describe('shouldNotify', () => {
  it('always announces an unknown finding', () => {
    assert.equal(shouldNotify(undefined, T0), true);
  });

  it('stays quiet before the reminder slot', () => {
    const state: AlertState = {
      notificationsSent: 1,
      lastNotifiedAtMs: T0,
      firstSeenAtMs: T0,
    };
    assert.equal(shouldNotify(state, T0 + 4 * 60_000), false);
    assert.equal(shouldNotify(state, T0 + 5 * 60_000), true);
  });

  it('spaces reminders further apart as the incident drags on', () => {
    const state: AlertState = {
      notificationsSent: 3,
      lastNotifiedAtMs: T0,
      firstSeenAtMs: T0 - 60 * 60_000,
    };
    assert.equal(shouldNotify(state, T0 + 29 * 60_000), false);
    assert.equal(shouldNotify(state, T0 + 30 * 60_000), true);
  });
});

describe('registerNotification', () => {
  it('seeds first-seen on the initial notification', () => {
    const state = registerNotification(undefined, T0);
    assert.deepEqual(state, {
      notificationsSent: 1,
      lastNotifiedAtMs: T0,
      firstSeenAtMs: T0,
    });
  });

  it('preserves first-seen across reminders', () => {
    const first = registerNotification(undefined, T0);
    const second = registerNotification(first, T0 + 10 * 60_000);
    assert.equal(second.notificationsSent, 2);
    assert.equal(second.firstSeenAtMs, T0);
    assert.equal(second.lastNotifiedAtMs, T0 + 10 * 60_000);
  });
});

describe('formatIncidentDuration', () => {
  it('formats sub-hour incidents in minutes', () => {
    assert.equal(formatIncidentDuration(90_000), '2min');
    assert.equal(formatIncidentDuration(59 * 60_000), '59min');
  });

  it('formats longer incidents in hours and minutes', () => {
    assert.equal(formatIncidentDuration(60 * 60_000), '1h00');
    assert.equal(formatIncidentDuration(125 * 60_000), '2h05');
  });

  it('clamps negative drift to zero', () => {
    assert.equal(formatIncidentDuration(-5000), '0min');
  });
});
