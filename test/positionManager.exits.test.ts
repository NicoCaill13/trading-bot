import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldActivateAtrTrail, shouldTriggerTimeStop } from '../src/exitPredicates';

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
