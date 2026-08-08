import { ATR } from 'technicalindicators';
import alpaca from './alpacaClient';
import config from './config';

/** Calendar days of 5m history — prior sessions included for ATR warmup at the open. */
const ATR_5M_LOOKBACK_DAYS = 7;

export async function fetchAtr5m(symbol: string): Promise<number> {
  const period = config.indicators.atrPeriod;
  const minBars = period + 1;
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - ATR_5M_LOOKBACK_DAYS);

  const highs: number[] = [];
  const lows: number[] = [];
  const closes: number[] = [];

  const iter = alpaca.getBarsV2(symbol, {
    start: start.toISOString(),
    end: end.toISOString(),
    timeframe: '5Min',
    feed: 'iex',
  });

  for await (const bar of iter) {
    highs.push(bar.HighPrice);
    lows.push(bar.LowPrice);
    closes.push(bar.ClosePrice);
  }

  if (highs.length < minBars) {
    throw new Error(
      `${symbol}: insufficient 5m history for ATR (${highs.length}/${minBars} bars)`,
    );
  }

  const atrValues = ATR.calculate({ period, high: highs, low: lows, close: closes });
  const atr = atrValues[atrValues.length - 1];

  if (!atr || atr <= 0) {
    throw new Error(`${symbol}: invalid 5m ATR value (${atr})`);
  }

  return atr;
}
