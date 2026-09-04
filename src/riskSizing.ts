/**
 * Pure V7 risk sizing helpers — no I/O, unit-testable.
 */

/**
 * Capital this strategy is allowed to deploy.
 *
 * A paper account funded far above the live account silently invalidates every
 * session test: tickets grow to a size no micro-cap book can absorb, and the
 * integer-share rounding that dominates at small size never shows up. Clamping
 * here keeps sizing, the notional cap and the dollar drawdown limit consistent
 * with the account the strategy is actually meant to run on.
 *
 * A cap of 0 means "use the whole account".
 */
export function resolveSizingCapital(
  accountEquity: number,
  strategyCapitalUsd: number,
): number {
  if (strategyCapitalUsd <= 0) return accountEquity;
  return Math.min(accountEquity, strategyCapitalUsd);
}

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

export function capQtyByBuyingPower(
  qty: number,
  entryPrice: number,
  availableBuyingPower: number,
): number {
  if (qty < 1 || entryPrice <= 0 || availableBuyingPower <= 0) return 0;
  return Math.min(qty, Math.floor(availableBuyingPower / entryPrice));
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

/**
 * Notional that integer-share rounding can actually put on the book under the
 * cash-account ceiling. A $110 ticket at $56 buys 1 share ($56) — half the
 * ticket — while $55 buys 2 ($110).
 */
export function computeDeployableNotional(
  entryPrice: number,
  capital: number,
  maxPositionPct: number,
): number {
  if (!(entryPrice > 0) || capital <= 0 || maxPositionPct <= 0) return 0;
  const maxNotional = capital * maxPositionPct;
  const qty = Math.floor(maxNotional / entryPrice);
  return qty < 1 ? 0 : qty * entryPrice;
}

/**
 * Fraction of the notional ceiling that one share-rounded ticket deploys.
 * 0 when the name is untradeable (price above the ceiling). 1 when the ticket
 * fills the cap. Used to rank signals by dollars at work, not by move size.
 */
export function ticketEfficiencyFactor(
  entryPrice: number,
  capital: number,
  maxPositionPct: number,
): number {
  if (!(entryPrice > 0) || capital <= 0 || maxPositionPct <= 0) return 0;
  const maxNotional = capital * maxPositionPct;
  if (!(maxNotional > 0)) return 0;
  const deployed = computeDeployableNotional(entryPrice, capital, maxPositionPct);
  if (deployed <= 0) return 0;
  if (deployed >= maxNotional - 1e-9) return 1;
  return deployed / maxNotional;
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
