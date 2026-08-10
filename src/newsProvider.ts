/**
 * News headlines port (#21). Alpaca News is the default adapter;
 * Finnhub (or others) can implement the same interface.
 */
import config from './config';
import { createLogger } from './logger';
import { toErrorMessage } from './utils';

const log = createLogger('NEWS');

export interface NewsHeadline {
  id: string;
  headline: string;
  summary: string | null;
  createdAt: string;
  symbols: string[];
  source: string | null;
  url: string | null;
}

export interface NewsProvider {
  getHeadlines(
    symbol: string,
    start: Date,
    end: Date,
  ): Promise<NewsHeadline[]>;
}

interface AlpacaNewsArticle {
  id?: number | string;
  headline?: string;
  summary?: string;
  created_at?: string;
  symbols?: string[];
  source?: string;
  url?: string;
}

interface AlpacaNewsResponse {
  news?: AlpacaNewsArticle[];
  next_page_token?: string | null;
}

function parseArticle(raw: AlpacaNewsArticle): NewsHeadline | null {
  const headline = typeof raw.headline === 'string' ? raw.headline.trim() : '';
  if (!headline) return null;
  const id =
    raw.id !== undefined && raw.id !== null
      ? String(raw.id)
      : `${raw.created_at ?? ''}:${headline.slice(0, 32)}`;
  return {
    id,
    headline,
    summary: typeof raw.summary === 'string' ? raw.summary : null,
    createdAt: typeof raw.created_at === 'string' ? raw.created_at : '',
    symbols: Array.isArray(raw.symbols)
      ? raw.symbols.filter((s): s is string => typeof s === 'string')
      : [],
    source: typeof raw.source === 'string' ? raw.source : null,
    url: typeof raw.url === 'string' ? raw.url : null,
  };
}

/**
 * Alpaca historical news: GET {dataUrl}/v1beta1/news
 * Auth: same APCA key/secret as market data.
 */
export class AlpacaNewsProvider implements NewsProvider {
  constructor(
    private readonly dataUrl: string = config.alpaca.dataUrl,
    private readonly keyId: string = config.alpaca.keyId,
    private readonly secretKey: string = config.alpaca.secretKey,
    private readonly limit: number = config.sentiment.maxHeadlinesPerSymbol,
  ) {}

  async getHeadlines(
    symbol: string,
    start: Date,
    end: Date,
  ): Promise<NewsHeadline[]> {
    const url = new URL('/v1beta1/news', this.dataUrl);
    url.searchParams.set('symbols', symbol);
    url.searchParams.set('start', start.toISOString());
    url.searchParams.set('end', end.toISOString());
    url.searchParams.set('sort', 'desc');
    url.searchParams.set('limit', String(Math.min(50, Math.max(1, this.limit))));

    try {
      const res = await fetch(url.toString(), {
        headers: {
          'APCA-API-KEY-ID': this.keyId,
          'APCA-API-SECRET-KEY': this.secretKey,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${symbol}`);
      }

      const json: unknown = await res.json();
      const payload = json as AlpacaNewsResponse;
      const articles = Array.isArray(payload.news) ? payload.news : [];
      const headlines: NewsHeadline[] = [];
      for (const article of articles) {
        const parsed = parseArticle(article);
        if (parsed) headlines.push(parsed);
      }
      return headlines;
    } catch (err: unknown) {
      log.warn(`Alpaca news failed for ${symbol}: ${toErrorMessage(err)}`);
      throw err;
    }
  }
}

/** No-op provider for tests / disabled paths that still need a stub. */
export class EmptyNewsProvider implements NewsProvider {
  async getHeadlines(
    _symbol: string,
    _start: Date,
    _end: Date,
  ): Promise<NewsHeadline[]> {
    return [];
  }
}

export function createNewsProvider(): NewsProvider {
  return new AlpacaNewsProvider();
}
