/**
 * Live entry-price sanitization for the IEX top-of-book.
 * A phantom ask several percent above last/signal must not arm anti-chase
 * nor size a marketable limit. A last trade that also ran away is a real pump.
 */

export interface LivePriceSnapshot {
  ask: number | null;
  lastTrade: number | null;
  minuteClose: number | null;
  signalClose: number;
}

export interface SanitizeLiveAskOptions {
  /** Fraction (0.01 = 1%). Same threshold as MAX_ENTRY_CHASE_PCT / 100. */
  staleAskExcess: number;
  /** Fraction added to the fallback anchor (0.001 = +0.1%). */
  virtualSlippage: number;
}

export interface SanitizedEntryPrice {
  price: number;
  usedStaleAskFallback: boolean;
}

function isPositive(value: number | null): value is number {
  return value !== null && value > 0;
}

function excessOverSignal(price: number, signalClose: number): number {
  if (signalClose <= 0) return 0;
  return (price - signalClose) / signalClose;
}

function isHealthyVsSignal(
  price: number,
  signalClose: number,
  staleAskExcess: number,
): boolean {
  return excessOverSignal(price, signalClose) <= staleAskExcess;
}

function applyVirtualSlippage(price: number, virtualSlippage: number): number {
  return price * (1 + virtualSlippage);
}

/**
 * Prefer a healthy ask. If the IEX ask sits more than `staleAskExcess` above
 * the signal close, treat it as stale: fall back to last trade (when itself
 * within the same band) or the signal close, plus virtual slippage.
 * A last trade that also exceeds the band is a real move — keep it so
 * anti-chase can still reject.
 */
export function sanitizeLiveAskPrice(
  snapshot: LivePriceSnapshot,
  options: SanitizeLiveAskOptions,
): SanitizedEntryPrice {
  const { ask, lastTrade, minuteClose, signalClose } = snapshot;
  const { staleAskExcess, virtualSlippage } = options;

  const last = isPositive(lastTrade) ? lastTrade : null;
  const minute = isPositive(minuteClose) ? minuteClose : null;
  const print = last ?? minute;

  if (isPositive(ask) && excessOverSignal(ask, signalClose) > staleAskExcess) {
    if (print !== null && isHealthyVsSignal(print, signalClose, staleAskExcess)) {
      return {
        price: applyVirtualSlippage(print, virtualSlippage),
        usedStaleAskFallback: true,
      };
    }
    if (print === null && signalClose > 0) {
      return {
        price: applyVirtualSlippage(signalClose, virtualSlippage),
        usedStaleAskFallback: true,
      };
    }
    return { price: print ?? ask, usedStaleAskFallback: false };
  }

  if (isPositive(ask)) return { price: ask, usedStaleAskFallback: false };
  if (print !== null) return { price: print, usedStaleAskFallback: false };
  return { price: signalClose, usedStaleAskFallback: false };
}
