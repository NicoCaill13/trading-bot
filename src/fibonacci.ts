import type { BarData, FibLevelName, FibLevels, FibProximity } from './types';

const FIB_RATIOS: Array<{ name: FibLevelName; ratio: number }> = [
  { name: '23.6', ratio: 0.236 },
  { name: '38.2', ratio: 0.382 },
  { name: '50.0', ratio: 0.500 },
  { name: '61.8', ratio: 0.618 },
  { name: '78.6', ratio: 0.786 },
];

/**
 * Computes standard Fibonacci retracement levels from a swing low to a swing high.
 * Each level = swingHigh - ratio * (swingHigh - swingLow), representing
 * how far the price would need to retrace toward the origin before resuming the trend.
 */
export function computeFibLevels(swingLow: number, swingHigh: number): FibLevels {
  const range = swingHigh - swingLow;
  return {
    swingLow,
    swingHigh,
    level_236: swingHigh - 0.236 * range,
    level_382: swingHigh - 0.382 * range,
    level_500: swingHigh - 0.500 * range,
    level_618: swingHigh - 0.618 * range,
    level_786: swingHigh - 0.786 * range,
  };
}

/**
 * Evaluates how close a given price is to the nearest Fibonacci retracement level.
 * distancePct is expressed as a percentage of the level price itself.
 * isNearSupport is true when distancePct <= tolerancePct.
 */
export function evaluateFibProximity(
  price: number,
  levels: FibLevels,
  tolerancePct: number,
): FibProximity {
  let nearestName: FibLevelName = '23.6';
  let nearestValue = levels.level_236;
  let minDist = Infinity;

  const levelValues: Array<{ name: FibLevelName; value: number }> = [
    { name: '23.6', value: levels.level_236 },
    { name: '38.2', value: levels.level_382 },
    { name: '50.0', value: levels.level_500 },
    { name: '61.8', value: levels.level_618 },
    { name: '78.6', value: levels.level_786 },
  ];

  for (const { name, value } of levelValues) {
    const dist = Math.abs(price - value) / value;
    if (dist < minDist) {
      minDist = dist;
      nearestName = name;
      nearestValue = value;
    }
  }

  const distancePct = minDist * 100;
  return {
    nearestLevel: nearestValue,
    nearestName,
    distancePct,
    isNearSupport: distancePct <= tolerancePct,
  };
}

/**
 * Derives Fibonacci retracement levels from a bar history.
 * swingLow  = minimum low across all bars.
 * swingHigh = max(localHigh, max high across all bars).
 * Returns null when the bar array is empty or when swingHigh <= swingLow
 * (degenerate range — typically too few bars at session open).
 * The minimum range guard (0.3% of swingHigh) prevents meaningless levels
 * from appearing when price has barely moved.
 */
export function deriveFibLevelsFromBars(
  bars: BarData[],
  localHigh: number,
): FibLevels | null {
  if (bars.length === 0) return null;

  let swingLow = bars[0].low;
  let swingHigh = localHigh;

  for (const b of bars) {
    if (b.low < swingLow) swingLow = b.low;
    if (b.high > swingHigh) swingHigh = b.high;
  }

  const minRangePct = 0.003;
  if (swingHigh <= swingLow || (swingHigh - swingLow) / swingHigh < minRangePct) {
    return null;
  }

  return computeFibLevels(swingLow, swingHigh);
}

/**
 * Formats a compact Fibonacci summary for logging.
 * E.g. "Fib 61.8% @ $24.65 (0.42% away) [near]"
 */
export function formatFibLog(prox: FibProximity): string {
  const tag = prox.isNearSupport ? 'near' : 'extended';
  return (
    `Fib ${prox.nearestName}% @ $${prox.nearestLevel.toFixed(2)} ` +
    `(${prox.distancePct.toFixed(2)}% away) [${tag}]`
  );
}

export { FIB_RATIOS };
