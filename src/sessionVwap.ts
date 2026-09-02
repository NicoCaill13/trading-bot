/**
 * Session VWAP — typical-price volume accumulator.
 *
 * The 1-min history used for RSI is truncated; this accumulator is not.
 * Seed from 04:00 then fold live bars (including last-bar replacements)
 * so Opening Drive still has a VWAP when 5-min REST hydrate is empty at 09:31.
 */

export interface VwapBar {
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface VwapAccumulator {
  tpv: number;
  volume: number;
}

export function emptyVwapAccumulator(): VwapAccumulator {
  return { tpv: 0, volume: 0 };
}

export function typicalPrice(bar: VwapBar): number {
  return (bar.high + bar.low + bar.close) / 3;
}

function signedVolume(bar: VwapBar): number {
  return bar.volume > 0 ? bar.volume : 0;
}

export function addBarToVwap(acc: VwapAccumulator, bar: VwapBar): VwapAccumulator {
  const volume = signedVolume(bar);
  return { tpv: acc.tpv + typicalPrice(bar) * volume, volume: acc.volume + volume };
}

export function removeBarFromVwap(acc: VwapAccumulator, bar: VwapBar): VwapAccumulator {
  const volume = signedVolume(bar);
  return { tpv: acc.tpv - typicalPrice(bar) * volume, volume: acc.volume - volume };
}

export function vwapFromAccumulator(acc: VwapAccumulator): number | null {
  if (!(acc.volume > 0)) return null;
  return acc.tpv / acc.volume;
}

export function computeVwap(bars: readonly VwapBar[]): number | null {
  let acc = emptyVwapAccumulator();
  for (const bar of bars) acc = addBarToVwap(acc, bar);
  return vwapFromAccumulator(acc);
}
