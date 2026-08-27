import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectOpeningRangeBar } from '../src/openingRange';
import type { BarData } from '../src/types';

const OPEN = 9 * 60 + 30;

function bar(timestamp: string, open: number): BarData {
  return { open, high: open + 0.1, low: open - 0.1, close: open, volume: 1000, timestamp };
}

describe('selectOpeningRangeBar', () => {
  it('skips premarket bars and keeps the 09:30 bar on a series starting at 04:00', () => {
    const bars = [
      bar('2026-08-27T08:00:00.000Z', 16.5), // 04:00 ET
      bar('2026-08-27T13:15:00.000Z', 16.9), // 09:15 ET
      bar('2026-08-27T13:30:00.000Z', 17.055), // 09:30 ET
      bar('2026-08-27T13:31:00.000Z', 17.2),
      bar('2026-08-27T13:35:00.000Z', 18.0),
    ];
    const selected = selectOpeningRangeBar(bars, OPEN);
    assert.ok(selected);
    assert.equal(selected.sessionOpen, 17.055);
    assert.equal(selected.rangeBar.timestamp, '2026-08-27T13:30:00.000Z');
  });

  it('still returns the 09:30 bar when seeding starts at 09:35', () => {
    const bars = [
      bar('2026-08-27T13:30:00.000Z', 17.055),
      bar('2026-08-27T13:31:00.000Z', 17.4),
      bar('2026-08-27T13:35:00.000Z', 18.18),
    ];
    const selected = selectOpeningRangeBar(bars, OPEN);
    assert.ok(selected);
    assert.equal(selected.sessionOpen, 17.055);
    assert.equal(selected.rangeBar.timestamp, '2026-08-27T13:30:00.000Z');
  });

  it('returns null when only premarket bars exist', () => {
    const bars = [bar('2026-08-27T13:15:00.000Z', 16.9)];
    assert.equal(selectOpeningRangeBar(bars, OPEN), null);
  });
});
