/**
 * Pre-open news as a candidate directional signal for the eligible-mover study.
 *
 * Classification reuses the bot's own strict gate (assessStrictBullishCatalyst)
 * so the study measures the rule the bot would actually apply: at least one
 * bullish headline and no bearish one.
 */

import config from '../../src/config';
import {
  parseArticle,
  type AlpacaNewsArticle,
  type NewsHeadline,
} from '../../src/newsProvider';
import { assessStrictBullishCatalyst } from '../../src/sentiment';
import { getJson } from './barFetch';

export type NewsClass = 'bullish' | 'other' | 'none';

const NEWS_PAGE_LIMIT = 50;
/** A window that needs more pages than this is reported as truncated, not silently cut. */
const MAX_PAGES = 60;

export function classifyNews(headlines: readonly NewsHeadline[]): NewsClass {
  if (headlines.length === 0) return 'none';
  return assessStrictBullishCatalyst(headlines).passes ? 'bullish' : 'other';
}

/** Headlines per requested symbol; an article tagging several symbols counts for each. */
export function groupBySymbol(
  articles: readonly NewsHeadline[],
  symbols: readonly string[],
): Map<string, NewsHeadline[]> {
  const wanted = new Set(symbols);
  const grouped = new Map<string, NewsHeadline[]>();
  for (const article of articles) {
    for (const symbol of article.symbols) {
      if (!wanted.has(symbol)) continue;
      const list = grouped.get(symbol);
      if (list) list.push(article);
      else grouped.set(symbol, [article]);
    }
  }
  return grouped;
}

export interface NewsWindowResult {
  headlines: NewsHeadline[];
  truncated: boolean;
}

/** Alpaca historical news for many symbols over one window, paginated. */
export async function fetchNewsWindow(
  symbols: readonly string[],
  start: Date,
  end: Date,
): Promise<NewsWindowResult> {
  const headlines: NewsHeadline[] = [];
  let pageToken: string | null = null;
  let pages = 0;

  do {
    const params = new URLSearchParams({
      symbols: symbols.join(','),
      start: start.toISOString(),
      end: end.toISOString(),
      sort: 'asc',
      limit: String(NEWS_PAGE_LIMIT),
    });
    if (pageToken) params.set('page_token', pageToken);

    const body = await getJson(`${config.alpaca.dataUrl}/v1beta1/news?${params.toString()}`);
    const articles = Array.isArray(body['news']) ? (body['news'] as AlpacaNewsArticle[]) : [];
    for (const article of articles) {
      const parsed = parseArticle(article);
      if (parsed !== null) headlines.push(parsed);
    }

    const next = body['next_page_token'];
    pageToken = typeof next === 'string' && next.length > 0 ? next : null;
    pages++;
  } while (pageToken !== null && pages < MAX_PAGES);

  return { headlines, truncated: pageToken !== null };
}
