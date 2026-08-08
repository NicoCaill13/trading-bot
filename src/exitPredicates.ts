/**
 * Pure exit predicates for V7 risk management — unit-testable, no I/O.
 */

/** True when position has stagnated without positive MFE for timeStopMinutes. */
export function shouldTriggerTimeStop(
  entryTimeIso: string,
  nowMs: number,
  mfePercent: number | null,
  timeStopMinutes: number,
): boolean {
  const entryMs = Date.parse(entryTimeIso);
  if (Number.isNaN(entryMs) || timeStopMinutes <= 0) return false;

  const elapsedMs = nowMs - entryMs;
  if (elapsedMs < timeStopMinutes * 60_000) return false;

  const mfe = mfePercent ?? 0;
  return mfe <= 0;
}

/** True when unrealized PnL (decimal) has reached the ATR trail trigger. */
export function shouldActivateAtrTrail(
  unrealizedPct: number,
  atrTrailTriggerPct: number,
): boolean {
  return unrealizedPct >= atrTrailTriggerPct;
}
