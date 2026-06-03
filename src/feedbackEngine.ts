import fs from 'fs/promises';
import path from 'path';
import config from './config';
import { createLogger } from './logger';
import type { AdaptiveFilters, TradeRecord } from './types';

const log = createLogger('FEEDBACK');

const ROLLING_WINDOW = 20;
const VWAP_DIST_THRESHOLD_PCT = 2.0;
const VWAP_DIST_MIN_SAMPLES = 3;
const VWAP_DIST_WIN_RATE_CAP = 0.30;
const VWAP_DIST_DEFAULT_CAP = 3.0;
const VWAP_DIST_FLOOR = 0.5;
const VWAP_DIST_CEILING = 5.0;

const GAP_CAP_THRESHOLD_PCT = 10.0;
const GAP_CAP_MIN_SAMPLES = 2;

const V1_BEARISH_MIN_SAMPLES = 3;
const V1_BEARISH_WIN_RATE_CAP = 0.30;

const ATR_STOP_MAE_MULTIPLIER = 2.5;

let currentFilters: AdaptiveFilters = buildDefaultFilters();

function buildDefaultFilters(): AdaptiveFilters {
  return {
    maxVwapEntryDistancePct: VWAP_DIST_DEFAULT_CAP,
    maxGapPctForEntry: null,
    blockV1WhenSpyBearish: false,
    atrStopTooWideWarning: false,
    computedAt: null,
  };
}

function isClosedTrade(record: TradeRecord): boolean {
  return record.exit_time !== null && record.net_pnl_dollars !== null;
}

function isWinner(record: TradeRecord): boolean {
  return (record.net_pnl_dollars ?? 0) > 0;
}

function computeVwapDistancePct(record: TradeRecord): number | null {
  if (record.vwap_at_entry <= 0) return null;
  return ((record.entry_price - record.vwap_at_entry) / record.vwap_at_entry) * 100;
}

function computeGapPct(record: TradeRecord): number | null {
  if (record.gap_percentage === null) return null;
  // Journal stores gap as decimal (0.02 = 2%) or percentage (12.6 = 12.6%) depending on source.
  // Normalize: values <= 1 are treated as decimals.
  const raw = record.gap_percentage;
  return raw <= 1 ? raw * 100 : raw;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function computeMaxVwapEntryDistancePct(records: TradeRecord[]): number {
  const extended = records.filter(r => {
    const dist = computeVwapDistancePct(r);
    return dist !== null && dist > VWAP_DIST_THRESHOLD_PCT;
  });

  if (extended.length >= VWAP_DIST_MIN_SAMPLES) {
    const winRate = extended.filter(isWinner).length / extended.length;
    if (winRate < VWAP_DIST_WIN_RATE_CAP) {
      return clamp(VWAP_DIST_THRESHOLD_PCT, VWAP_DIST_FLOOR, VWAP_DIST_CEILING);
    }
  }

  return clamp(VWAP_DIST_DEFAULT_CAP, VWAP_DIST_FLOOR, VWAP_DIST_CEILING);
}

function computeMaxGapPctForEntry(records: TradeRecord[]): number | null {
  const highGap = records.filter(r => {
    const gap = computeGapPct(r);
    return gap !== null && gap > GAP_CAP_THRESHOLD_PCT;
  });

  if (highGap.length >= GAP_CAP_MIN_SAMPLES && highGap.every(r => !isWinner(r))) {
    return GAP_CAP_THRESHOLD_PCT;
  }

  return null;
}

function computeBlockV1WhenSpyBearish(records: TradeRecord[]): boolean {
  const v1Bearish = records.filter(
    r => r.origin === 'V1_CORE' && r.spy_trend_5m === 'bearish',
  );

  if (v1Bearish.length < V1_BEARISH_MIN_SAMPLES) return false;

  const winRate = v1Bearish.filter(isWinner).length / v1Bearish.length;
  return winRate < V1_BEARISH_WIN_RATE_CAP;
}

function computeAtrStopTooWideWarning(records: TradeRecord[]): boolean {
  const hardCloseLosers = records.filter(
    r =>
      r.exit_reason === 'hard-close' &&
      !isWinner(r) &&
      r.mae_percent !== null,
  );

  if (hardCloseLosers.length === 0) return false;

  const avgMae = hardCloseLosers.reduce(
    (sum, r) => sum + Math.abs(r.mae_percent ?? 0),
    0,
  ) / hardCloseLosers.length;

  const threshold = ATR_STOP_MAE_MULTIPLIER * config.risk.hardStopFloorPct * 100;
  return avgMae > threshold;
}

function computeFilters(records: TradeRecord[]): AdaptiveFilters {
  const closed = records
    .filter(isClosedTrade)
    .slice(-ROLLING_WINDOW);

  const filters: AdaptiveFilters = {
    maxVwapEntryDistancePct: computeMaxVwapEntryDistancePct(closed),
    maxGapPctForEntry: computeMaxGapPctForEntry(closed),
    blockV1WhenSpyBearish: computeBlockV1WhenSpyBearish(closed),
    atrStopTooWideWarning: computeAtrStopTooWideWarning(closed),
    computedAt: new Date().toISOString(),
  };

  log.info(
    `Adaptive filters updated (${closed.length} trade(s)) — ` +
    `maxVwapDist:${filters.maxVwapEntryDistancePct.toFixed(2)}% ` +
    `maxGap:${filters.maxGapPctForEntry ?? 'none'} ` +
    `blockV1Bearish:${filters.blockV1WhenSpyBearish} ` +
    `atrStopWide:${filters.atrStopTooWideWarning}`,
  );

  return filters;
}

async function loadClosedRecords(journalPath: string): Promise<TradeRecord[]> {
  const resolved = path.resolve(journalPath);
  try {
    const raw = await fs.readFile(resolved, 'utf8');
    const records = JSON.parse(raw) as TradeRecord[];
    return records.filter(isClosedTrade);
  } catch {
    return [];
  }
}

export async function init(journalPath: string): Promise<void> {
  await refresh(journalPath);
}

export async function refresh(journalPath: string): Promise<void> {
  const records = await loadClosedRecords(journalPath);
  currentFilters = records.length > 0 ? computeFilters(records) : buildDefaultFilters();
}

export function getFilters(): AdaptiveFilters {
  return { ...currentFilters };
}
