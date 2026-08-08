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
