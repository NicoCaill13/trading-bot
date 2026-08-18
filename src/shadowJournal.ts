/**
 * Shadow journal for the Opening Drive path (#29 Étape 4).
 *
 * Answers one question with data instead of intuition: would these setups have
 * made money, and is the anti-chase cap rejecting winners? Every observation is
 * kept out of `journal.json` on purpose — the FeedbackEngine retunes live entry
 * filters from that file, and hypothetical fills must never influence it.
 *
 * Excursions are tracked on bar highs and lows rather than closes, unlike
 * `journalManager.updateExcursions`: a theoretical stop would trigger intrabar,
 * so a close-only simulation would report profits on trades that were actually
 * stopped out.
 */

import config from './config';
import { createLogger } from './logger';
import { readJson, writeJsonAtomic } from './jsonStore';
import { estCalendarDayKey, toESTDate, toErrorMessage } from './utils';
import type {
  BarData,
  OpeningDriveDecision,
  OpeningDriveRejection,
  ShadowSignalRecord,
} from './types';

const log = createLogger('SHADOW');

/** Records still inside their observation horizon, keyed by symbol + signal time. */
const openRecords = new Map<string, ShadowSignalRecord>();
/** Closed records awaiting persistence. */
let pendingFlush: ShadowSignalRecord[] = [];
let flushInFlight: Promise<void> | null = null;

function recordKey(symbol: string, signalAt: string): string {
  return `${symbol}|${signalAt}`;
}

// ---------------------------------------------------------------------------
// Pure tracking logic
// ---------------------------------------------------------------------------

export interface ShadowSignalInput {
  symbol: string;
  signalAt: string;
  decision: OpeningDriveDecision;
  straightRunScore: number;
  rejectedBy: OpeningDriveRejection | null;
  horizonMinutes: number;
}

export function createShadowRecord(input: ShadowSignalInput): ShadowSignalRecord {
  const { decision } = input;
  return {
    symbol: input.symbol,
    strategy: 'opening_drive',
    tradingDay: estCalendarDayKey(toESTDate(new Date(input.signalAt))),
    signalAt: input.signalAt,
    rejectedBy: input.rejectedBy,
    entryPrice: decision.entryPrice ?? 0,
    stopPrice: decision.stopPrice ?? 0,
    extensionPct: decision.extensionPct ?? 0,
    rvol1m: decision.rvol1m,
    imbalance: decision.imbalance,
    straightRunScore: input.straightRunScore,
    horizonMinutes: input.horizonMinutes,
    mfePct: 0,
    maePct: 0,
    mfeBarIndex: null,
    stopHitBarIndex: null,
    stopHit: false,
    stopHitBeforeMfe: false,
    barsObserved: 0,
    closedAt: null,
  };
}

/**
 * Folds one observation bar into a record, returning a new record.
 *
 * Immutable by design: ticks for several symbols are handled concurrently, and
 * mutating a shared record in place invites torn reads on the flush path.
 */
export function applyBarToShadowRecord(
  record: ShadowSignalRecord,
  bar: BarData,
): ShadowSignalRecord {
  const { entryPrice } = record;
  if (entryPrice <= 0) return record;

  const barIndex = record.barsObserved;
  const barMfe = (bar.high - entryPrice) / entryPrice;
  const barMae = (bar.low - entryPrice) / entryPrice;

  const setsNewMfe = barMfe > record.mfePct;
  const mfePct = setsNewMfe ? barMfe : record.mfePct;
  const mfeBarIndex = setsNewMfe ? barIndex : record.mfeBarIndex;
  const maePct = barMae < record.maePct ? barMae : record.maePct;

  const touchesStop = record.stopPrice > 0 && bar.low <= record.stopPrice;
  const stopHitBarIndex = record.stopHitBarIndex ?? (touchesStop ? barIndex : null);
  const stopHit = stopHitBarIndex !== null;

  // No favorable excursion at all means the stop necessarily came first.
  const stopHitBeforeMfe = stopHitBarIndex !== null
    && (mfeBarIndex === null || stopHitBarIndex <= mfeBarIndex);

  return {
    ...record,
    mfePct,
    maePct,
    mfeBarIndex,
    stopHitBarIndex,
    stopHit,
    stopHitBeforeMfe,
    barsObserved: barIndex + 1,
  };
}

/** True once the bar sits beyond the record's observation horizon. */
export function isHorizonElapsed(record: ShadowSignalRecord, bar: BarData): boolean {
  const signalMs = new Date(record.signalAt).getTime();
  const barMs = new Date(bar.timestamp).getTime();
  if (Number.isNaN(signalMs) || Number.isNaN(barMs)) return false;
  return barMs - signalMs > record.horizonMinutes * 60_000;
}

export function summarizeShadowRecord(record: ShadowSignalRecord): string {
  const verdict = record.stopHitBeforeMfe
    ? 'STOPPED before MFE'
    : record.stopHit
      ? 'MFE then stopped'
      : 'never stopped';
  return (
    `${record.symbol} ${record.rejectedBy ?? 'armed'} — ` +
    `entry $${record.entryPrice.toFixed(2)} stop $${record.stopPrice.toFixed(2)} | ` +
    `MFE ${(record.mfePct * 100).toFixed(2)}% MAE ${(record.maePct * 100).toFixed(2)}% | ` +
    `${record.barsObserved} bar(s) | ${verdict}`
  );
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * Opens an observation. Returns false when an identical one already exists, so
 * callers can stay idempotent across duplicate bars.
 */
export function recordShadowSignal(input: ShadowSignalInput): boolean {
  const key = recordKey(input.symbol, input.signalAt);
  if (openRecords.has(key)) return false;

  const record = createShadowRecord(input);
  openRecords.set(key, record);
  log.info(
    `${record.symbol}: observing ${record.rejectedBy ?? 'armed'} setup — ` +
    `entry $${record.entryPrice.toFixed(2)} stop $${record.stopPrice.toFixed(2)} ` +
    `over ${record.horizonMinutes} min`,
  );
  return true;
}

/**
 * Applies a bar to every open record of that symbol and closes the ones whose
 * horizon has elapsed. Cheap no-op when the symbol has no observation.
 */
export function updateShadowRecords(symbol: string, bar: BarData): void {
  for (const [key, record] of openRecords) {
    if (record.symbol !== symbol) continue;

    if (isHorizonElapsed(record, bar)) {
      closeRecord(key, record, bar.timestamp);
      continue;
    }
    openRecords.set(key, applyBarToShadowRecord(record, bar));
  }
}

function closeRecord(key: string, record: ShadowSignalRecord, closedAt: string): void {
  openRecords.delete(key);
  const closed: ShadowSignalRecord = { ...record, closedAt };
  pendingFlush.push(closed);
  log.info(`verdict — ${summarizeShadowRecord(closed)}`);
}

/**
 * Closes every open observation, whatever its remaining horizon. Called at the
 * end of session and on daily reset: a partially observed setup still carries
 * the excursion data the calibration needs.
 */
export function closeAllShadowRecords(closedAt: string): void {
  for (const [key, record] of openRecords) {
    closeRecord(key, record, closedAt);
  }
}

export function openRecordCount(): number {
  return openRecords.size;
}

export function pendingFlushCount(): number {
  return pendingFlush.length;
}

/**
 * Appends closed records to the shadow file.
 *
 * Read-modify-write is acceptable here: a handful of records per session, and
 * the file is never on a latency-sensitive path. Serialized through a single
 * in-flight promise so two flushes cannot drop each other's batch.
 */
export async function flushShadowRecords(): Promise<void> {
  if (flushInFlight !== null) {
    await flushInFlight;
    return;
  }
  if (pendingFlush.length === 0) return;

  const batch = pendingFlush;
  pendingFlush = [];

  flushInFlight = (async (): Promise<void> => {
    const filePath = config.paths.shadowSignals;
    try {
      const existing = await readJson(filePath);
      const history = Array.isArray(existing) ? (existing as ShadowSignalRecord[]) : [];
      await writeJsonAtomic(filePath, [...history, ...batch], { pretty: true });
      log.info(`${batch.length} record(s) persisted — ${filePath}`);
    } catch (err) {
      // Put the batch back so the next flush retries instead of losing data.
      pendingFlush = [...batch, ...pendingFlush];
      log.warn(`flush failed, ${batch.length} record(s) retained — ${toErrorMessage(err)}`);
    }
  })();

  try {
    await flushInFlight;
  } finally {
    flushInFlight = null;
  }
}

export function reset(): void {
  openRecords.clear();
  pendingFlush = [];
}
