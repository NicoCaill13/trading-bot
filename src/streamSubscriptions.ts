/**
 * Alpaca IEX live stream budget. Code 405 is "symbol limit exceeded".
 *
 * Empirically the cap is 30 *streams*, not 30 tickers: bars+quotes+trades on
 * 8 names (24) works, the same triple on 17 names (51) is refused in full.
 * SIP is not under this ceiling. Callers pass `maxStreams` for the active feed.
 *
 * Opening Drive fail-opens on missing quotes and tape, so bars fill first,
 * then trades, then quotes.
 */

export interface StreamChannelPlan {
  bars: string[];
  quotes: string[];
  trades: string[];
}

export interface StreamChannelOptions {
  maxStreams: number;
  quotesEnabled: boolean;
  tradesEnabled: boolean;
}

export function uniqueSymbols(symbols: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const symbol of symbols) {
    if (symbol.length === 0 || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push(symbol);
  }
  return out;
}

export function countStreams(plan: StreamChannelPlan): number {
  return plan.bars.length + plan.quotes.length + plan.trades.length;
}

export function allocateStreamChannels(
  symbols: readonly string[],
  opts: StreamChannelOptions,
): StreamChannelPlan {
  const unique = uniqueSymbols(symbols);
  const max = Math.max(0, Math.floor(opts.maxStreams));
  const bars = unique.slice(0, max);
  let remaining = max - bars.length;

  const trades: string[] = [];
  if (opts.tradesEnabled && remaining > 0) {
    trades.push(...bars.slice(0, remaining));
    remaining -= trades.length;
  }

  const quotes: string[] = [];
  if (opts.quotesEnabled && remaining > 0) {
    quotes.push(...bars.slice(0, remaining));
  }

  return { bars, quotes, trades };
}

export function describeStreamPlan(plan: StreamChannelPlan): string {
  return (
    `${plan.bars.length} bars, ${plan.quotes.length} quotes, ` +
    `${plan.trades.length} trades (${countStreams(plan)} streams)`
  );
}
