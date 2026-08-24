import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeTrailLockedPct,
  shouldActivateAtrTrail,
  shouldTriggerTimeStop,
} from '../src/exitPredicates';

describe('shouldTriggerTimeStop', () => {
  const entry = '2026-08-08T14:00:00.000Z';

  it('triggers after 45m with non-positive MFE', () => {
    const now = Date.parse(entry) + 45 * 60_000;
    assert.equal(shouldTriggerTimeStop(entry, now, 0, 45), true);
    assert.equal(shouldTriggerTimeStop(entry, now, -0.5, 45), true);
    assert.equal(shouldTriggerTimeStop(entry, now, null, 45), true);
  });

  it('does not trigger before 45m', () => {
    const now = Date.parse(entry) + 44 * 60_000;
    assert.equal(shouldTriggerTimeStop(entry, now, 0, 45), false);
  });

  it('does not trigger when MFE is positive', () => {
    const now = Date.parse(entry) + 60 * 60_000;
    assert.equal(shouldTriggerTimeStop(entry, now, 0.1, 45), false);
  });
});

describe('shouldActivateAtrTrail', () => {
  it('activates at or above +1.5% unrealized', () => {
    assert.equal(shouldActivateAtrTrail(0.015, 0.015), true);
    assert.equal(shouldActivateAtrTrail(0.02, 0.015), true);
  });

  it('stays inactive below trigger', () => {
    assert.equal(shouldActivateAtrTrail(0.014, 0.015), false);
  });
});

describe('computeTrailLockedPct', () => {
  it('reports a loss when the trail is armed below its own width', () => {
    // The rejected Hyper-Growth pairing: +10% trigger with a 12% trail lands the
    // stop under entry, looser than the 2.5% hard floor it replaces.
    const locked = computeTrailLockedPct(0.10, 0.12);
    assert.ok(locked < 0, `expected a negative lock, got ${locked}`);
    assert.ok(Math.abs(locked - -0.032) < 1e-9);
  });

  it('is flat exactly at trail / (1 - trail)', () => {
    const trail = 0.12;
    const breakEvenTrigger = trail / (1 - trail);
    assert.ok(Math.abs(computeTrailLockedPct(breakEvenTrigger, trail)) < 1e-12);
  });

  it('locks a gain at the shipped 20% / 12% pairing', () => {
    const locked = computeTrailLockedPct(0.20, 0.12);
    assert.ok(Math.abs(locked - 0.056) < 1e-9, `got ${locked}`);
  });
});
