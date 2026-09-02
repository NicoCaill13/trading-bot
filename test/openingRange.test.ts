import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeSessionImpulseHigh, selectOpeningRangeBar } from '../src/openingRange';
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

describe('computeSessionImpulseHigh', () => {
  it('tracks the 09:31–09:33 drive, not a quiet 09:30 print (CDE 02/09)', () => {
    const range = {
      open: 20.67, high: 20.89, low: 20.67, close: 20.89, volume: 2981,
      timestamp: '2026-09-02T13:30:00Z',
    };
    const bars: BarData[] = [
      range,
      { open: 20.93, high: 20.99, low: 20.91, close: 20.99, volume: 2199, timestamp: '2026-09-02T13:31:00Z' },
      { open: 21.00, high: 21.12, low: 20.96, close: 21.12, volume: 4223, timestamp: '2026-09-02T13:32:00Z' },
      { open: 21.23, high: 21.42, low: 21.23, close: 21.42, volume: 5029, timestamp: '2026-09-02T13:33:00Z' },
      { open: 21.41, high: 21.41, low: 21.34, close: 21.38, volume: 3600, timestamp: '2026-09-02T13:34:00Z' },
    ];
    assert.equal(computeSessionImpulseHigh(bars, range), 21.42);
  });

  it('ignores premarket highs above the RTH range', () => {
    const range = bar('2026-08-27T13:30:00.000Z', 17.055);
    const bars = [
      { ...bar('2026-08-27T13:15:00.000Z', 16.9), high: 30 },
      range,
      { ...bar('2026-08-27T13:31:00.000Z', 17.4), high: 17.5 },
    ];
    assert.equal(computeSessionImpulseHigh(bars, range), 17.5);
  });
});
