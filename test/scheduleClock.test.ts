import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { zonedWallTimeToUtc } from '../src/utils';

describe('zonedWallTimeToUtc Europe/Paris', () => {
  it('maps 14:00 to 13:00 UTC in winter', () => {
    const winter = new Date(2026, 0, 15);
    const instant = zonedWallTimeToUtc(winter, 14, 0, 'Europe/Paris');
    assert.equal(instant.toISOString(), '2026-01-15T13:00:00.000Z');
  });

  it('maps 14:00 to 12:00 UTC in summer', () => {
    const summer = new Date(2026, 6, 15);
    const instant = zonedWallTimeToUtc(summer, 14, 0, 'Europe/Paris');
    assert.equal(instant.toISOString(), '2026-07-15T12:00:00.000Z');
  });
});
