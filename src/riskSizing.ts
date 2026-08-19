/**
 * Pure V7 risk sizing helpers — no I/O, unit-testable.
 */

export function computeRiskBasedQty(
  equity: number,
  riskPct: number,
  entryPrice: number,
  stopLossPrice: number,
): number {
  const stopDistance = entryPrice - stopLossPrice;
  if (equity <= 0 || riskPct <= 0 || entryPrice <= 0 || stopDistance <= 0) {
    return 0;
  }
  const riskDollars = equity * riskPct;
  return Math.floor(riskDollars / stopDistance);
}

export function computeTakeProfitPrice(
  entryPrice: number,
  stopLossPrice: number,
  minRiskRewardRatio: number,
): number {
  const stopDistance = entryPrice - stopLossPrice;
  return entryPrice + minRiskRewardRatio * stopDistance;
}

export function passesMinRiskReward(
  entryPrice: number,
  stopLossPrice: number,
  takeProfitPrice: number,
  minRiskRewardRatio: number,
): boolean {
  const stopDistance = entryPrice - stopLossPrice;
  if (stopDistance <= 0) return false;
  const rewardDistance = takeProfitPrice - entryPrice;
  return rewardDistance / stopDistance >= minRiskRewardRatio;
}

export function capQtyBySettledCash(
  qty: number,
  entryPrice: number,
  settledCash: number,
): number {
  if (qty < 1 || entryPrice <= 0 || settledCash <= 0) return 0;
  return Math.min(qty, Math.floor(settledCash / entryPrice));
}

/**
 * Cash-account notional ceiling: qty * entryPrice <= equity * maxPositionPct.
 * Prevents leverage when a tight stop inflates risk-based share count.
 */
export function capQtyByMaxNotional(
  qty: number,
  entryPrice: number,
  equity: number,
  maxPositionPct: number,
): number {
  if (qty < 1 || entryPrice <= 0 || equity <= 0 || maxPositionPct <= 0) return 0;
  const maxNotional = equity * maxPositionPct;
  return Math.min(qty, Math.floor(maxNotional / entryPrice));
}

/** Open slots in the unified pool. Never negative. */
export function remainingPositionSlots(openCount: number, maxPositions: number): number {
  if (maxPositions < 1) return 0;
  return Math.max(0, maxPositions - openCount);
}

/**
 * Daily profit circuit. A target of 0 (or negative) is inactive — the drawdown
 * kill-switch is a separate gate and must not be overloaded onto this check.
 */
export function isDailyProfitTargetReached(dailyPnlPct: number, targetPct: number): boolean {
  if (targetPct <= 0) return false;
  return dailyPnlPct >= targetPct;
}
