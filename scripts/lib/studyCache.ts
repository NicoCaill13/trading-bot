/**
 * Per-session cache shared by the eligible-mover studies.
 *
 * One file per session keeps a long run resumable and lets a later study read
 * what an earlier one computed instead of refetching a year of minute bars.
 */

import { readJson, writeJsonAtomic } from '../../src/jsonStore';
import type {
  IntradayOutcome,
  OpeningConfirm,
  PreOpenFeatures,
} from './eligibleStudy';

export interface SimSummary {
  outcome: IntradayOutcome;
  returnPct: number;
  maxFavourablePct: number;
}

export interface StudyRow extends PreOpenFeatures {
  session: string;
  symbol: string;
  inBaseline: boolean;
  /** Minute bars were requested for this name. */
  attempted: boolean;
  /** Null when not attempted or when the name never printed at the entry minute. */
  sim: SimSummary | null;
  confirm: OpeningConfirm | null;
}

export const STUDY_CACHE_VERSION = 'v2';

export function studyCacheDir(targetPct: number, stopPct: number): string {
  return `./data/study_eligible/${STUDY_CACHE_VERSION}_t${targetPct}_s${stopPct}`;
}

function isCachedRows(value: unknown): value is StudyRow[] {
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return true;
  const first: unknown = value[0];
  return (
    typeof first === 'object' &&
    first !== null &&
    typeof (first as { symbol?: unknown }).symbol === 'string' &&
    typeof (first as { gapPct?: unknown }).gapPct === 'number'
  );
}

export async function loadCachedRows(dir: string, session: string): Promise<StudyRow[] | null> {
  const value = await readJson(`${dir}/${session}.json`);
  return isCachedRows(value) ? value : null;
}

export async function saveCachedRows(
  dir: string,
  session: string,
  rows: readonly StudyRow[],
): Promise<void> {
  await writeJsonAtomic(`${dir}/${session}.json`, rows);
}
