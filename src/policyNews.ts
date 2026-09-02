/**
 * General Alpaca news pull for the policy monitor.
 *
 * Kept out of `newsProvider.ts` so the sentiment / screener path is byte-stable.
 * Same auth headers and article shape as AlpacaNewsProvider.
 */

import config from './config';
import { createLogger } from './logger';
import { toErrorMessage } from './utils';
import type { NewsHeadline } from './newsProvider';

const log = createLogger('POLICY');
const FETCH_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseArticle(raw: unknown): NewsHeadline | null {
  if (!isRecord(raw)) return null;
  const headline = typeof raw['headline'] === 'string' ? raw['headline'].trim() : '';
  if (!headline) return null;
  const idValue = raw['id'];
  const createdAt = typeof raw['created_at'] === 'string' ? raw['created_at'] : '';
  const id =
    idValue !== undefined && idValue !== null
      ? String(idValue)
      : `${createdAt}:${headline.slice(0, 32)}`;
  const symbolsRaw = raw['symbols'];
  return {
    id,
    headline,
    summary: typeof raw['summary'] === 'string' ? raw['summary'] : null,
    createdAt,
    symbols: Array.isArray(symbolsRaw)
      ? symbolsRaw.filter((s): s is string => typeof s === 'string')
      : [],
    source: typeof raw['source'] === 'string' ? raw['source'] : null,
    url: typeof raw['url'] === 'string' ? raw['url'] : null,
  };
}

export async function fetchRecentPolicyNews(
  start: Date,
  end: Date,
  opts: { limit?: number; dataUrl?: string; keyId?: string; secretKey?: string } = {},
): Promise<NewsHeadline[]> {
  const limit = Math.min(50, Math.max(1, opts.limit ?? 50));
  const dataUrl = opts.dataUrl ?? config.alpaca.dataUrl;
  const keyId = opts.keyId ?? config.alpaca.keyId;
  const secretKey = opts.secretKey ?? config.alpaca.secretKey;

  const url = new URL('/v1beta1/news', dataUrl);
  url.searchParams.set('start', start.toISOString());
  url.searchParams.set('end', end.toISOString());
  url.searchParams.set('sort', 'desc');
  url.searchParams.set('limit', String(limit));

  try {
    const res = await fetch(url.toString(), {
      headers: {
        'APCA-API-KEY-ID': keyId,
        'APCA-API-SECRET-KEY': secretKey,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const json: unknown = await res.json();
    if (!isRecord(json)) return [];
    const news = json['news'];
    if (!Array.isArray(news)) return [];
    const headlines: NewsHeadline[] = [];
    for (const article of news) {
      const parsed = parseArticle(article);
      if (parsed) headlines.push(parsed);
    }
    return headlines;
  } catch (err: unknown) {
    log.warn(`Alpaca policy news failed: ${toErrorMessage(err)}`);
    throw err;
  }
}
