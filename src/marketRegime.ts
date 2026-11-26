import { computeSmaAt } from './weinstein';
import type { IndexRegime, MarketRegimeStatus, PriceBar } from './types';

export interface RegimeOpts {
  distributionWindow: number;
  distributionDeclinePct: number;
  distributionRallyResetPct: number;
  pressureDistributionMin: number;
  correctionDistributionMin: number;
  sma50Period: number;
  sma200Period: number;
  sma50SlopeBars: number;
}

export interface DistributionDay {
  index: number;
  close: number;
}

/**
 * O'Neil distribution day: decline of at least `declinePct` on higher volume
 * than the previous session. A day drops out of the count once price has
 * rallied `rallyResetPct` above that day's close, or once it leaves the window.
 */
export function findActiveDistributionDays(
  bars: readonly PriceBar[],
  window: number,
  declinePct: number,
  rallyResetPct: number,
): DistributionDay[] {
  const n = bars.length;
  if (window < 2 || n < 2) return [];
  const start = Math.max(1, n - window);
  const active: DistributionDay[] = [];

  for (let i = start; i < n; i++) {
    const prev = bars[i - 1];
    const bar = bars[i];
    if (!(prev.close > 0) || !(bar.volume > prev.volume)) continue;
    const change = bar.close / prev.close - 1;
    if (change > -declinePct) continue;

    let reset = false;
    const resetLevel = bar.close * (1 + rallyResetPct);
    for (let j = i + 1; j < n; j++) {
      if (bars[j].close >= resetLevel) {
        reset = true;
        break;
      }
    }
    if (!reset) active.push({ index: i, close: bar.close });
  }

  return active;
}

export function countDistributionDays(
  bars: readonly PriceBar[],
  window: number,
  declinePct: number,
  rallyResetPct: number,
): number {
  return findActiveDistributionDays(bars, window, declinePct, rallyResetPct).length;
}

export function exposureFor(status: MarketRegimeStatus): 0 | 50 | 100 {
  if (status === 'CONFIRMED_UPTREND') return 100;
  if (status === 'UPTREND_UNDER_PRESSURE') return 50;
  return 0;
}

const STATUS_RANK: Record<MarketRegimeStatus, number> = {
  CONFIRMED_UPTREND: 0,
  UPTREND_UNDER_PRESSURE: 1,
  CORRECTION: 2,
};

/** The more defensive of the two indexes wins. */
export function combineRegimes(regimes: readonly IndexRegime[]): {
  status: MarketRegimeStatus;
  recommendedExposurePct: 0 | 50 | 100;
} {
  let worst: MarketRegimeStatus = 'CONFIRMED_UPTREND';
  for (const regime of regimes) {
    if (STATUS_RANK[regime.status] > STATUS_RANK[worst]) worst = regime.status;
  }
  if (regimes.length === 0) worst = 'CORRECTION';
  return { status: worst, recommendedExposurePct: exposureFor(worst) };
}

export function assessIndexRegime(
  symbol: string,
  bars: readonly PriceBar[],
  opts: RegimeOpts,
): IndexRegime | null {
  const closes = bars.map(b => b.close);
  const n = closes.length;
  const sma50 = computeSmaAt(closes, n, opts.sma50Period);
  const sma200 = computeSmaAt(closes, n, opts.sma200Period);
  const sma50Prev = computeSmaAt(closes, n - opts.sma50SlopeBars, opts.sma50Period);
  if (sma50 === null || sma200 === null || sma50Prev === null) return null;

  const close = closes[n - 1];
  if (!(close > 0)) return null;

  const distributionDays = countDistributionDays(
    bars,
    opts.distributionWindow,
    opts.distributionDeclinePct,
    opts.distributionRallyResetPct,
  );
  const sma50Rising = sma50 > sma50Prev;

  let status: MarketRegimeStatus;
  if (close < sma200 || distributionDays >= opts.correctionDistributionMin) {
    status = 'CORRECTION';
  } else if (
    close > sma50 &&
    sma50 > sma200 &&
    sma50Rising &&
    distributionDays <= opts.pressureDistributionMin - 1
  ) {
    status = 'CONFIRMED_UPTREND';
  } else {
    status = 'UPTREND_UNDER_PRESSURE';
  }

  return {
    symbol,
    status,
    close,
    sma50,
    sma200,
    sma50Rising,
    distributionDays,
    recommendedExposurePct: exposureFor(status),
  };
}
