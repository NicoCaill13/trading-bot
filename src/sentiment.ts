/**
 * Lightweight lexicon sentiment + bullish catalyst gate (#21).
 * Pure classification — news I/O lives behind NewsProvider.
 */
import config from './config';
import { createLogger } from './logger';
import { toErrorMessage } from './utils';
import type { NewsProvider, NewsHeadline } from './newsProvider';
import type { NewsSentiment, WatchlistSymbol } from './types';

const log = createLogger('SENTIMENT');

const BULLISH_TERMS = [
  'upgrade',
  'upgraded',
  'beats',
  'beat estimates',
  'surge',
  'surges',
  'soar',
  'soars',
  'rally',
  'rallies',
  'record high',
  'all-time high',
  'raises guidance',
  'raises outlook',
  'raised guidance',
  'buyout',
  'acquisition',
  'acquired',
  'merger',
  'partnership',
  'breakthrough',
  'fda approval',
  'fda clears',
  'contract win',
  'wins contract',
  'outperform',
  'overweight',
  'initiates buy',
  'price target raised',
  'strong buy',
] as const;

const BEARISH_TERMS = [
  'downgrade',
  'downgraded',
  'misses',
  'missed estimates',
  'plunge',
  'plunges',
  'tumble',
  'tumbles',
  'lawsuit',
  'probe',
  'investigation',
  'fraud',
  'bankruptcy',
  'chapter 11',
  'cuts guidance',
  'cut guidance',
  'lowers outlook',
  'warning',
  'layoffs',
  'underperform',
  'underweight',
  'price target cut',
  'sell rating',
  'sec charges',
  'delisting',
] as const;

export interface HeadlineSentiment {
  sentiment: NewsSentiment;
  bullHits: number;
  bearHits: number;
  score: number;
}

export interface CatalystAssessment {
  passes: boolean;
  sentiment: NewsSentiment;
  catalystScore: number;
  catalystHeadline: string | null;
  headlineCount: number;
}

function countTermHits(text: string, terms: readonly string[]): number {
  let hits = 0;
  for (const term of terms) {
    if (text.includes(term)) hits += 1;
  }
  return hits;
}

/**
 * Classify a single headline with a deterministic lexicon.
 * Ties / no hits → NEUTRAL. Bearish wins ties when both > 0? Spec: clear majority.
 */
export function classifyHeadline(headline: string): HeadlineSentiment {
  const text = headline.toLowerCase();
  const bullHits = countTermHits(text, BULLISH_TERMS);
  const bearHits = countTermHits(text, BEARISH_TERMS);
  const score = bullHits - bearHits;

  let sentiment: NewsSentiment = 'NEUTRAL';
  if (bullHits > bearHits && bullHits > 0) sentiment = 'BULLISH';
  else if (bearHits > bullHits && bearHits > 0) sentiment = 'BEARISH';

  return { sentiment, bullHits, bearHits, score };
}

/**
 * Require at least one BULLISH headline in the lookback window.
 * Empty / fetch-failed list → fails the gate (anti pump without catalyst).
 */
export function assessBullishCatalyst(
  headlines: readonly NewsHeadline[],
): CatalystAssessment {
  if (headlines.length === 0) {
    return {
      passes: false,
      sentiment: 'NEUTRAL',
      catalystScore: 0,
      catalystHeadline: null,
      headlineCount: 0,
    };
  }

  let bestBull: NewsHeadline | null = null;
  let bestScore = 0;
  let bullishCount = 0;
  let worstSentiment: NewsSentiment = 'NEUTRAL';

  for (const h of headlines) {
    const classified = classifyHeadline(h.headline);
    if (classified.sentiment === 'BEARISH') worstSentiment = 'BEARISH';
    if (classified.sentiment === 'BULLISH') {
      bullishCount += 1;
      if (classified.score > bestScore || bestBull === null) {
        bestScore = classified.score;
        bestBull = h;
      }
    }
  }

  if (bestBull !== null) {
    return {
      passes: true,
      sentiment: 'BULLISH',
      catalystScore: bullishCount,
      catalystHeadline: bestBull.headline,
      headlineCount: headlines.length,
    };
  }

  return {
    passes: false,
    sentiment: worstSentiment === 'BEARISH' ? 'BEARISH' : 'NEUTRAL',
    catalystScore: 0,
    catalystHeadline: headlines[0]?.headline ?? null,
    headlineCount: headlines.length,
  };
}

export function isSentimentFilterActive(): boolean {
  return config.sentiment.enabled;
}

async function mapConcurrent<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

/**
 * When SENTIMENT_FILTER_ENABLED: keep only symbols with ≥1 BULLISH headline
 * in the lookback window; enrich catalyst fields. When disabled: passthrough.
 */
export async function filterWatchlistByBullishCatalyst(
  entries: readonly WatchlistSymbol[],
  provider: NewsProvider,
): Promise<WatchlistSymbol[]> {
  if (!config.sentiment.enabled) {
    return [...entries];
  }

  if (entries.length === 0) return [];

  const lookbackMs = config.sentiment.lookbackHours * 60 * 60 * 1000;
  const end = new Date();
  const start = new Date(end.getTime() - lookbackMs);
  const concurrency = config.sentiment.fetchConcurrency;

  log.info(
    `Catalyst gate on ${entries.length} symbol(s) — ` +
      `lookback ${config.sentiment.lookbackHours}h, concurrency ${concurrency}`,
  );

  const assessed = await mapConcurrent(
    [...entries],
    async (entry): Promise<WatchlistSymbol | null> => {
      try {
        const headlines = await provider.getHeadlines(entry.symbol, start, end);
        const result = assessBullishCatalyst(headlines);
        if (!result.passes) {
          log.info(
            `${entry.symbol} REJECTED — no BULLISH catalyst ` +
              `(headlines=${result.headlineCount}, sentiment=${result.sentiment})`,
          );
          return null;
        }
        log.info(
          `${entry.symbol} PASS — BULLISH catalyst score=${result.catalystScore} ` +
            `| "${(result.catalystHeadline ?? '').slice(0, 80)}"`,
        );
        return {
          ...entry,
          sentiment: result.sentiment,
          catalystScore: result.catalystScore,
          catalystHeadline: result.catalystHeadline ?? undefined,
        };
      } catch (err: unknown) {
        log.warn(
          `${entry.symbol} REJECTED — news fetch failed: ${toErrorMessage(err)}`,
        );
        return null;
      }
    },
    concurrency,
  );

  const kept = assessed.filter((e): e is WatchlistSymbol => e !== null);
  log.info(
    `Catalyst gate retained ${kept.length}/${entries.length} symbol(s)`,
  );
  return kept;
}
