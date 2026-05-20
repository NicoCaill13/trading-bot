'use strict';

const fs = require('fs').promises;
const path = require('path');
const Alpaca = require('@alpacahq/alpaca-trade-api');
const config = require('./config');

const alpaca = new Alpaca({
  keyId: config.alpaca.keyId,
  secretKey: config.alpaca.secretKey,
  baseUrl: config.alpaca.baseUrl,
  paper: config.alpaca.paper,
});

// S&P 500 + Nasdaq 100 representative universe (expandable)
const UNIVERSE = [
  'AAPL','MSFT','NVDA','AMZN','META','GOOGL','TSLA','AVGO','JPM','LLY',
  'V','UNH','XOM','MA','JNJ','WMT','PG','MRK','HD','COST',
  'ORCL','CVX','ABBV','BAC','KO','PEP','NFLX','CRM','TMO','MCD',
  'ACN','CSCO','AMD','ABT','DHR','TXN','NEE','PM','INTC','IBM',
  'QCOM','HON','LIN','AMGN','INTU','GE','SPGI','ISRG','UNP','LOW',
  'CAT','GS','MS','BLK','AXP','NOW','BKNG','AMAT','ADI','LRCX',
  'TJX','PLD','SYK','DE','VRTX','REGN','MU','KLAC','PANW','SNPS',
  'CDNS','MELI','CRWD','ZS','DDOG','SNOW','COIN','PLTR','APP','RBLX',
  'UBER','LYFT','DASH','SHOP','SQ','PYPL','ADBE','COP','EOG','SLB',
  'SCHW','C','WFC','USB','PNC','TFC','COF','AIG','PRU','MET',
];

const BENCHMARK = 'SPY';

async function fetchDailyBars(symbol, limit) {
  const end = new Date();
  const start = new Date();
  // fetch enough history to cover lookback + volume average window
  start.setDate(start.getDate() - (limit + 5));

  const bars = [];
  const iter = alpaca.getBarsV2(symbol, {
    start: start.toISOString().split('T')[0],
    end: end.toISOString().split('T')[0],
    timeframe: '1Day',
    limit: limit + 5,
    feed: 'iex',
  });

  for await (const bar of iter) {
    bars.push(bar);
  }

  return bars.slice(-limit);
}

function computeReturn(bars) {
  if (bars.length < 2) return null;
  const first = bars[0].ClosePrice;
  const last = bars[bars.length - 1].ClosePrice;
  return (last - first) / first;
}

function computeRelativeVolume(bars, averageDays) {
  if (bars.length < averageDays + 1) return null;
  const recent = bars[bars.length - 1];
  const historicalSlice = bars.slice(-(averageDays + 1), -1);
  const avgVolume = historicalSlice.reduce((sum, b) => sum + b.Volume, 0) / historicalSlice.length;
  if (avgVolume === 0) return null;
  return recent.Volume / avgVolume;
}

function computeGapUp(bars) {
  if (bars.length < 2) return null;
  const prev = bars[bars.length - 2].ClosePrice;
  const open = bars[bars.length - 1].OpenPrice;
  return (open - prev) / prev;
}

async function computeBenchmarkReturn(lookbackDays) {
  console.log(`[SCREENER] Fetching benchmark data for ${BENCHMARK}...`);
  const bars = await fetchDailyBars(BENCHMARK, lookbackDays + config.screener.volumeAverageDays);
  return computeReturn(bars.slice(-lookbackDays));
}

async function analyzeSymbol(symbol, benchmarkReturn, lookbackDays) {
  try {
    const needed = lookbackDays + config.screener.volumeAverageDays + 2;
    const bars = await fetchDailyBars(symbol, needed);

    if (bars.length < needed) {
      console.log(`[SCREENER] ${symbol}: insufficient history (${bars.length}/${needed}), skipping`);
      return null;
    }

    const symbolReturn = computeReturn(bars.slice(-lookbackDays));
    const relativeVolume = computeRelativeVolume(bars, config.screener.volumeAverageDays);
    const gapUp = computeGapUp(bars);

    if (symbolReturn === null || relativeVolume === null || gapUp === null) return null;

    const outperformsBenchmark = symbolReturn > benchmarkReturn;
    const hasGapUp = gapUp >= config.screener.minGapUpPct;
    const hasVolume = relativeVolume >= config.screener.minRelativeVolume;

    if (!outperformsBenchmark || !hasGapUp || !hasVolume) return null;

    return {
      symbol,
      relativeReturn: symbolReturn - benchmarkReturn,
      symbolReturn,
      gapUp,
      relativeVolume,
      lastClose: bars[bars.length - 1].ClosePrice,
      lastOpen: bars[bars.length - 1].OpenPrice,
    };
  } catch (err) {
    console.log(`[SCREENER] ${symbol}: error during analysis — ${err.message}`);
    return null;
  }
}

// Throttle concurrent API calls to avoid hitting rate limits
async function throttledMap(items, fn, concurrency = 5) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    if (i + concurrency < items.length) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  return results;
}

async function runScreener() {
  console.log('[SCREENER] Starting post-session screening...');
  const lookbackDays = config.screener.relativeStrengthLookbackDays;

  const benchmarkReturn = await computeBenchmarkReturn(lookbackDays);
  console.log(`[SCREENER] Benchmark ${BENCHMARK} return over ${lookbackDays}d: ${(benchmarkReturn * 100).toFixed(2)}%`);

  const candidates = await throttledMap(
    UNIVERSE,
    symbol => analyzeSymbol(symbol, benchmarkReturn, lookbackDays),
    5,
  );

  const filtered = candidates
    .filter(Boolean)
    .sort((a, b) => b.relativeReturn - a.relativeReturn)
    .slice(0, config.screener.watchlistMaxSize);

  console.log(`[SCREENER] ${filtered.length} symbols selected for watchlist`);
  filtered.forEach(s => {
    console.log(
      `[SCREENER]   ${s.symbol.padEnd(6)} | rel.return: ${(s.relativeReturn * 100).toFixed(2)}% ` +
      `| gap: ${(s.gapUp * 100).toFixed(2)}% | rvol: ${s.relativeVolume.toFixed(2)}x`,
    );
  });

  const watchlist = {
    generatedAt: new Date().toISOString(),
    benchmarkReturn,
    symbols: filtered,
  };

  const outputPath = path.resolve(config.paths.watchlist);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(watchlist, null, 2));
  console.log(`[SCREENER] Watchlist saved to ${outputPath}`);

  return watchlist;
}

module.exports = { runScreener };
