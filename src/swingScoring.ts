import { capQtyByMaxNotional, computeRiskBasedQty } from './riskSizing';
import type {
  StudyGrade,
  SwingSetup,
  WeeklyAssessment,
  WeeklyClearance,
} from './types';

export interface ScoreInput {
  rsRating: number | null;
  setup: SwingSetup;
  riskPct: number;
  adrPct: number;
  distanceFromHigh52wPct: number | null;
  weekly?: WeeklyAssessment | null;
  clearance?: WeeklyClearance | null;
}

export interface ScoreResult {
  masterScore: number;
  grade: StudyGrade;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function scoreWeekly(
  weekly: WeeklyAssessment | null | undefined,
  clearance: WeeklyClearance | null | undefined,
): number {
  if (!weekly) return 10;

  let trendPts = 0;
  if (weekly.stage === 'STAGE_2') {
    trendPts = weekly.maAligned ? 8 : 5;
  } else if (weekly.stage === 'STAGE_1') {
    trendPts = 3;
  }

  let clearancePts = 4;
  if (clearance) {
    if (clearance.blueSky) {
      clearancePts = 8;
    } else if (clearance.roomToResistanceR !== null) {
      clearancePts = 8 * clamp01((clearance.roomToResistanceR - 1) / 4);
    } else {
      clearancePts = 0;
    }
  }

  let accumPts = 0;
  if (weekly.tightWeeksCount >= 3) accumPts += 2;
  if (clearance?.nearSma10wSupport) accumPts += 2;

  return trendPts + clearancePts + accumPts;
}

/**
 * 100-point multi-timeframe study score.
 * RS 20, daily contraction / dry-up 20, weekly structure / S-R clearance 20,
 * pivot location & breakout volume 15, 52-week high proximity 15, risk vs ADR 10.
 */
export function scoreSetup(input: ScoreInput): ScoreResult {
  const rs = input.rsRating === null ? 0 : clamp01(input.rsRating / 99) * 20;

  const dry = input.setup.volumeDryUpRatio === null
    ? 0.5
    : clamp01(1 - input.setup.volumeDryUpRatio);
  const steps = input.setup.contractionDepths.length;
  const contraction = steps === 0 ? 0.4 : clamp01(steps / 4);
  const compression = (0.6 * dry + 0.4 * contraction) * 20;

  const weeklyPts = scoreWeekly(input.weekly, input.clearance);

  let location = 6;
  if (input.setup.state === 'FORMING_AT_PIVOT') location = 12;
  if (input.setup.state === 'FRESH_BREAKOUT') {
    const rvol = input.setup.rvol ?? 0;
    location = 15 * clamp01(rvol / 3);
  }

  const distance = input.distanceFromHigh52wPct;
  const highProximity = distance === null
    ? 0
    : (1 - clamp01(distance / 0.25)) * 15;

  const adr = input.adrPct / 100;
  const asymmetry = input.riskPct <= 0
    ? 0
    : input.riskPct <= adr
      ? 10
      : 10 * clamp01(adr / input.riskPct);

  const masterScore = Math.round(
    rs + compression + weeklyPts + location + highProximity + asymmetry,
  );
  let grade: StudyGrade = 'B';
  if (masterScore >= 80) grade = 'A+';
  else if (masterScore >= 65) grade = 'A';

  return { masterScore, grade };
}

export interface TheoreticalPlan {
  entry: number;
  riskPct: number;
  target2r: number;
  target3r: number;
  qty: number;
}

export function buildTheoreticalPlan(
  setup: SwingSetup,
  close: number,
  capital: number,
  riskPerTradePct: number,
  maxPositionPct: number,
): TheoreticalPlan | null {
  const entry = setup.state === 'FRESH_BREAKOUT' ? close : setup.pivot;
  if (!(entry > setup.stop) || !(entry > 0)) return null;
  const riskPct = (entry - setup.stop) / entry;
  const qty = capQtyByMaxNotional(
    computeRiskBasedQty(capital, riskPerTradePct, entry, setup.stop),
    entry,
    capital,
    maxPositionPct,
  );
  const riskPerShare = entry - setup.stop;
  return {
    entry,
    riskPct,
    target2r: entry + 2 * riskPerShare,
    target3r: entry + 3 * riskPerShare,
    qty,
  };
}
