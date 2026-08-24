/**
 * Pure exit predicates for V7 risk management — unit-testable, no I/O.
 *
 * Trail arithmetic lives here so config validation, live exits, and the
 * Opening Drive harness cannot drift apart.
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
 * Lowest trigger at which a percent trail still locks a non-negative gain.
 * Arming at this level is break-even vs entry; anything lower is a risk widener.
 */
export function minProfitLockingTriggerPct(trailPct: number): number {
  if (!(trailPct > 0) || trailPct >= 1) return Number.POSITIVE_INFINITY;
  return trailPct / (1 - trailPct);
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

/** Strict: the stop placed at arm sits above entry. */
export function isProfitLockingTrail(triggerPct: number, trailPct: number): boolean {
  return computeTrailLockedPct(triggerPct, trailPct) > 0;
}
