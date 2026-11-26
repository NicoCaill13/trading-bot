import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateWeeklyBars,
  assessWeeklyStructure,
  clusterPriceLevels,
  countTightWeeklyCloses,
  evaluateWeeklyClearance,
  isoWeekMonday,
} from '../src/weeklyStructure';
import type { DatedDailyBar, WeeklyBar } from '../src/types';

function makeWeek(weekIdx: number, close: number, high = close * 1.02, low = close * 0.98): WeeklyBar {
  const baseMs = Date.UTC(2025, 0, 6) + weekIdx * 7 * 86_400_000;
  const start = new Date(baseMs).toISOString().slice(0, 10);
  const end = new Date(baseMs + 4 * 86_400_000).toISOString().slice(0, 10);
  return {
    weekStart: start,
    weekEnd: end,
    sessions: 5,
    open: close,
    high,
    low,
    close,
    volume: 1_000_000,
  };
}

describe('isoWeekMonday & aggregateWeeklyBars', () => {
  it('maps any weekday in the same ISO week to its Monday', () => {
    assert.equal(isoWeekMonday('2026-11-23'), '2026-11-23'); // Monday
    assert.equal(isoWeekMonday('2026-11-25'), '2026-11-23'); // Wednesday
    assert.equal(isoWeekMonday('2026-11-27'), '2026-11-23'); // Friday
  });

  it('aggregates holiday-shortened and partial weeks accurately', () => {
    const daily: DatedDailyBar[] = [
      { day: '2026-11-16', open: 50, high: 52, low: 49, close: 51, volume: 100 },
      { day: '2026-11-17', open: 51, high: 55, low: 50, close: 54, volume: 150 },
      { day: '2026-11-20', open: 54, high: 54, low: 48, close: 53, volume: 200 },
      // Next ISO week (partial, up to Wednesday)
      { day: '2026-11-23', open: 53, high: 56, low: 52, close: 55, volume: 120 },
      { day: '2026-11-25', open: 55, high: 58, low: 54, close: 57, volume: 180 },
    ];

    const weeks = aggregateWeeklyBars(daily);
    assert.equal(weeks.length, 2);

    assert.equal(weeks[0].weekStart, '2026-11-16');
    assert.equal(weeks[0].weekEnd, '2026-11-20');
    assert.equal(weeks[0].sessions, 3);
    assert.equal(weeks[0].open, 50);
    assert.equal(weeks[0].high, 55);
    assert.equal(weeks[0].low, 48);
    assert.equal(weeks[0].close, 53);
    assert.equal(weeks[0].volume, 450);

    assert.equal(weeks[1].weekStart, '2026-11-23');
    assert.equal(weeks[1].sessions, 2);
    assert.equal(weeks[1].close, 57);
  });
});

describe('clusterPriceLevels & countTightWeeklyCloses', () => {
  it('merges nearby weekly pivots into zones and keeps distant levels apart', () => {
    const zones = clusterPriceLevels([100, 101.2, 99.5, 120, 121], 0.02);
    assert.equal(zones.length, 2);
    assert.equal(zones[0].touches, 3);
    assert.equal(zones[1].touches, 2);
  });

  it('detects O\'Neil 3-Weeks Tight closes', () => {
    const weeks = [
      makeWeek(0, 80),
      makeWeek(1, 90),
      makeWeek(2, 100.0),
      makeWeek(3, 100.8),
      makeWeek(4, 100.2),
    ];
    assert.equal(countTightWeeklyCloses(weeks, 0.015), 3);
  });
});

describe('assessWeeklyStructure & evaluateWeeklyClearance', () => {
  it('identifies Stage 2 advancing trend in Blue Sky with aligned MAs', () => {
    const weeks: WeeklyBar[] = [];
    for (let i = 0; i < 48; i++) {
      weeks.push(makeWeek(i, 40 + i * 1.2));
    }

    const weekly = assessWeeklyStructure(weeks);
    assert.ok(weekly);
    assert.equal(weekly.stage, 'STAGE_2');
    assert.equal(weekly.maAligned, true);
    assert.ok(weekly.sma10w > weekly.sma30w);
    assert.ok(weekly.sma40w !== null && weekly.sma30w > weekly.sma40w);

    const lastClose = weeks[weeks.length - 1].close;
    const clearance = evaluateWeeklyClearance(weekly, lastClose, lastClose * 0.95);
    assert.equal(clearance.blueSky, true);
    assert.equal(clearance.nearestResistance, null);
    assert.ok(clearance.nearestSupport !== null);
  });

  it('flags Stage 4 decline and overhead weekly resistance ceiling', () => {
    const weeks: WeeklyBar[] = [];
    // Build a prior major peak around 120 then a prolonged decline to 65, now bouncing to 72
    for (let i = 0; i < 15; i++) weeks.push(makeWeek(i, 90 + i * 2));
    weeks.push(makeWeek(15, 122, 125, 118)); // Swing high peak at 125
    for (let i = 16; i < 46; i++) {
      weeks.push(makeWeek(i, 120 - (i - 15) * 1.8));
    }

    const stage4 = assessWeeklyStructure(weeks);
    assert.ok(stage4);
    assert.equal(stage4.stage, 'STAGE_4');

    // Simulate a Stage 2 recovery that still faces an old weekly peak at 106 just above pivot 100
    const recovery: WeeklyBar[] = [];
    for (let i = 0; i < 10; i++) recovery.push(makeWeek(i, 95));
    recovery[5] = makeWeek(5, 104, 106, 100); // Overhead weekly resistance at 106
    for (let i = 10; i < 22; i++) recovery.push(makeWeek(i, 75));
    for (let i = 22; i < 50; i++) {
      recovery.push(makeWeek(i, 76 + (i - 22) * 0.85));
    }

    const weekly = assessWeeklyStructure(recovery);
    assert.ok(weekly);
    assert.equal(weekly.stage, 'STAGE_2');

    // Entry at 100, stop at 95 (risk = 5). Resistance at 106 is only +1.2R away (< 2R)!
    const clearance = evaluateWeeklyClearance(weekly, 100, 95);
    assert.equal(clearance.blueSky, false);
    assert.ok(clearance.nearestResistance !== null);
    assert.ok(
      clearance.roomToResistanceR !== null &&
      clearance.roomToResistanceR < 2.0,
    );
  });
});
