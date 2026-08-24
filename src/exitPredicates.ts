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

/**
 * Gain locked in, as a fraction of entry, the moment a percent trail is armed.
 *
 * The broker anchors `trail_percent` on the high-water mark, so arming at +T
 * with a trail of R immediately places the stop at (1+T)(1−R) − 1 relative to
 * entry. A non-positive result means arming the trail replaces the protective
 * stop with a looser one: the position can then travel from a gain to a loss
 * without any exit firing.
 */
export function computeTrailLockedPct(
  triggerPct: number,
  trailPct: number,
): number {
  return (1 + triggerPct) * (1 - trailPct) - 1;
}
