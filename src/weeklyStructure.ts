import { findSwingHighs, findSwingLows } from './patterns/bars';
import { computeSmaAt } from './weinstein';
import type {
  DatedDailyBar,
  PriceZone,
  WeeklyAssessment,
  WeeklyBar,
  WeeklyClearance,
  WeinsteinStage,
} from './types';

export interface WeeklyStructureOpts {
  sma10Period: number;
  sma30Period: number;
  sma40Period: number;
  slopeWeeks: number;
  swingWing: number;
  zoneTolerancePct: number;
  tightWeekTolerancePct: number;
  overheadBufferPct: number;
}

export const DEFAULT_WEEKLY_OPTS: WeeklyStructureOpts = {
  sma10Period: 10,
  sma30Period: 30,
  sma40Period: 40,
  slopeWeeks: 4,
  swingWing: 2,
  zoneTolerancePct: 0.02,
  tightWeekTolerancePct: 0.015,
  overheadBufferPct: 0.015,
};

/**
 * Returns the Monday YYYY-MM-DD of the ISO week containing `day` (YYYY-MM-DD).
 * Uses pure UTC calendar arithmetic so local timezone offsets cannot shift days.
 */
export function isoWeekMonday(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) {
    throw new Error(`[WEEKLY] Invalid calendar day: "${day}"`);
  }
  const utcMs = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const d = new Date(utcMs);
  const dow = d.getUTCDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + diffToMonday);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * Aggregates chronological daily bars into ISO-week bars (Monday to Friday).
 * Holiday-shortened weeks stay single bars instead of drifting like 5-bar slices.
 */
export function aggregateWeeklyBars(daily: readonly DatedDailyBar[]): WeeklyBar[] {
  if (daily.length === 0) return [];

  const weeks: WeeklyBar[] = [];
  let current: WeeklyBar | null = null;

  for (const bar of daily) {
    const weekStart = isoWeekMonday(bar.day);
    if (current === null || current.weekStart !== weekStart) {
      if (current !== null) weeks.push(current);
      current = {
        weekStart,
        weekEnd: bar.day,
        sessions: 1,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      };
    } else {
      current.weekEnd = bar.day;
      current.sessions += 1;
      if (bar.high > current.high) current.high = bar.high;
      if (bar.low < current.low) current.low = bar.low;
      current.close = bar.close;
      current.volume += bar.volume;
    }
  }

  if (current !== null) weeks.push(current);
  return weeks;
}

/**
 * Merges nearby pivot prices within `tolerancePct` into weighted support or
 * resistance zones sorted ascending by price.
 */
export function clusterPriceLevels(
  levels: readonly number[],
  tolerancePct: number,
): PriceZone[] {
  const valid = levels.filter(p => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  if (valid.length === 0) return [];

  const zones: PriceZone[] = [];
  let clusterSum = valid[0];
  let clusterCount = 1;

  for (let i = 1; i < valid.length; i++) {
    const mean = clusterSum / clusterCount;
    if ((valid[i] - mean) / mean <= tolerancePct) {
      clusterSum += valid[i];
      clusterCount += 1;
    } else {
      zones.push({ price: clusterSum / clusterCount, touches: clusterCount });
      clusterSum = valid[i];
      clusterCount = 1;
    }
  }
  zones.push({ price: clusterSum / clusterCount, touches: clusterCount });
  return zones;
}

/**
 * Counts consecutive recent weekly closes staying within `tolerancePct` of
 * each other (O'Neil 3-Weeks Tight institutional accumulation signature).
 */
export function countTightWeeklyCloses(
  weeks: readonly WeeklyBar[],
  tolerancePct: number,
): number {
  if (weeks.length < 2) return weeks.length;
  let count = 1;
  const anchor = weeks[weeks.length - 1].close;
  if (!(anchor > 0)) return 0;

  for (let i = weeks.length - 2; i >= 0; i--) {
    const c = weeks[i].close;
    if (!(c > 0)) break;
    if (Math.abs(c - anchor) / anchor <= tolerancePct) {
      count += 1;
    } else {
      break;
    }
  }
  return count;
}

function classifyWeinsteinStage(
  close: number,
  sma10w: number,
  sma30w: number,
  sma30wSlopePct: number,
): WeinsteinStage {
  const flatSlopeThreshold = 0.005; // 0.5% over slopeWeeks (~4 weeks)
  if (close > sma30w && sma30wSlopePct > 0) {
    return 'STAGE_2';
  }
  if (close < sma30w && sma30wSlopePct < -flatSlopeThreshold) {
    return 'STAGE_4';
  }
  if (close >= sma30w && sma30wSlopePct <= 0 && sma10w < sma30w) {
    return 'STAGE_3';
  }
  if (close < sma30w && sma30wSlopePct > 0) {
    return 'STAGE_3';
  }
  return 'STAGE_1';
}

/**
 * Evaluates weekly trend, Weinstein stage, moving-average alignment, tight
 * closes, and structural weekly support/resistance zones over the last 52 weeks.
 */
export function assessWeeklyStructure(
  weeks: readonly WeeklyBar[],
  opts: WeeklyStructureOpts = DEFAULT_WEEKLY_OPTS,
): WeeklyAssessment | null {
  const n = weeks.length;
  const minNeeded = opts.sma30Period + opts.slopeWeeks;
  if (n < minNeeded) return null;

  const closes = weeks.map(w => w.close);
  const close = closes[n - 1];
  if (!(close > 0)) return null;

  const sma10w = computeSmaAt(closes, n, opts.sma10Period);
  const sma30w = computeSmaAt(closes, n, opts.sma30Period);
  const sma30wPrev = computeSmaAt(closes, n - opts.slopeWeeks, opts.sma30Period);
  const sma40w = n >= opts.sma40Period ? computeSmaAt(closes, n, opts.sma40Period) : null;

  if (sma10w === null || sma30w === null || sma30wPrev === null || !(sma30wPrev > 0)) {
    return null;
  }

  const sma30wSlopePct = (sma30w - sma30wPrev) / sma30wPrev;
  const stage = classifyWeinsteinStage(close, sma10w, sma30w, sma30wSlopePct);
  const maAligned =
    close > sma10w &&
    sma10w >= sma30w &&
    (sma40w === null || sma30w >= sma40w);

  const lookbackWeeks = weeks.slice(-52);
  const highIdx = findSwingHighs(lookbackWeeks, opts.swingWing);
  const lowIdx = findSwingLows(lookbackWeeks, opts.swingWing);

  const priorWeeks = lookbackWeeks.slice(
    0,
    Math.max(0, lookbackWeeks.length - opts.swingWing),
  );
  let priorPeak52w = -Infinity;
  for (const w of priorWeeks) {
    if (w.high > priorPeak52w) priorPeak52w = w.high;
  }

  const rawHighs = highIdx.map(i => lookbackWeeks[i].high);
  if (Number.isFinite(priorPeak52w) && priorPeak52w > 0) rawHighs.push(priorPeak52w);
  const rawLows = lowIdx.map(i => lookbackWeeks[i].low);

  // Polarity principle: broken weekly swing highs below price act as support,
  // and broken weekly swing lows above price act as overhead resistance.
  const supportCandidates = [
    ...rawLows.filter(p => p <= close),
    ...rawHighs.filter(p => p <= close * 0.99),
  ];
  const resistanceCandidates = [
    ...rawHighs.filter(p => p > close),
    ...rawLows.filter(p => p > close * 1.01),
  ];

  const supportZones = clusterPriceLevels(supportCandidates, opts.zoneTolerancePct);
  const resistanceZones = clusterPriceLevels(resistanceCandidates, opts.zoneTolerancePct);
  const tightWeeksCount = countTightWeeklyCloses(weeks, opts.tightWeekTolerancePct);

  return {
    stage,
    close,
    sma10w,
    sma30w,
    sma40w,
    sma30wSlopePct,
    maAligned,
    tightWeeksCount,
    supportZones,
    resistanceZones,
  };
}

/**
 * Measures distance to the nearest weekly support below entry and nearest
 * overhead resistance above entry (ignoring the current base pivot itself).
 */
export function evaluateWeeklyClearance(
  weekly: WeeklyAssessment,
  entry: number,
  stop: number,
  overheadBufferPct = DEFAULT_WEEKLY_OPTS.overheadBufferPct,
): WeeklyClearance {
  const riskPerShare = entry - stop;

  // Include rising weekly MAs below entry as dynamic institutional support.
  const candidateSupports: PriceZone[] = [...weekly.supportZones];
  if (weekly.sma10w <= entry) {
    candidateSupports.push({ price: weekly.sma10w, touches: 1 });
  }
  if (weekly.sma30w <= entry) {
    candidateSupports.push({ price: weekly.sma30w, touches: 1 });
  }

  let nearestSupport: PriceZone | null = null;
  for (const zone of candidateSupports) {
    if (zone.price <= entry) {
      if (nearestSupport === null || zone.price > nearestSupport.price) {
        nearestSupport = zone;
      }
    }
  }

  const minOverheadPrice = entry * (1 + overheadBufferPct);
  let nearestResistance: PriceZone | null = null;
  for (const zone of weekly.resistanceZones) {
    if (zone.price > minOverheadPrice) {
      if (nearestResistance === null || zone.price < nearestResistance.price) {
        nearestResistance = zone;
      }
    }
  }

  const blueSky = nearestResistance === null;
  const roomToResistancePct =
    nearestResistance !== null && entry > 0
      ? (nearestResistance.price - entry) / entry
      : null;
  const roomToResistanceR =
    nearestResistance !== null && riskPerShare > 0
      ? (nearestResistance.price - entry) / riskPerShare
      : null;

  const nearSma10wSupport =
    weekly.close >= weekly.sma10w * 0.98 &&
    weekly.close <= weekly.sma10w * 1.05;

  return {
    nearestSupport,
    nearestResistance,
    blueSky,
    roomToResistancePct,
    roomToResistanceR,
    nearSma10wSupport,
  };
}
