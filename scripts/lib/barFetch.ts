/**
 * Research-only market data access: multi-symbol bars over raw REST.
 *
 * The production path goes through the SDK one symbol at a time, which is right
 * for a live session but would take hours to sweep a whole universe over weeks
 * of history. This module exists for offline studies and is deliberately kept
 * out of src/ so nothing in the live bot can depend on it.
 */

import config from '../../src/config';

export type Feed = 'iex' | 'sip';

export interface RawBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/**
 * Symbols per request. The endpoint caps on URL length, not symbol count, so a
 * larger batch means far fewer requests against the rate limit.
 */
const SYMBOL_BATCH_SIZE = 800;
const MAX_ATTEMPTS = 8;
/** Free tier allows 200 req/min; stay under it rather than absorb 429s. */
const MIN_REQUEST_INTERVAL_MS = 340;

const headers = {
  'APCA-API-KEY-ID': config.alpaca.keyId,
  'APCA-API-SECRET-KEY': config.alpaca.secretKey,
};

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

let nextRequestAt = 0;

/** Serialises requests so the whole process stays under the rate limit. */
async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, nextRequestAt - now);
  nextRequestAt = Math.max(now, nextRequestAt) + MIN_REQUEST_INTERVAL_MS;
  if (wait > 0) await sleep(wait);
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  let backoffMs = 1_000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await throttle();
    const res = await fetch(url, { headers });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30_000);
      continue;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  throw new Error(`rate limited after ${MAX_ATTEMPTS} attempts: ${url}`);
}

/** Bars for many symbols, paginated and merged. Symbols with no data are absent. */
export async function fetchBars(
  symbols: readonly string[],
  timeframe: string,
  start: Date,
  end: Date,
  feed: Feed,
): Promise<Map<string, RawBar[]>> {
  const merged = new Map<string, RawBar[]>();

  for (let i = 0; i < symbols.length; i += SYMBOL_BATCH_SIZE) {
    const batch = symbols.slice(i, i + SYMBOL_BATCH_SIZE);
    let pageToken: string | null = null;

    do {
      const params = new URLSearchParams({
        symbols: batch.join(','),
        timeframe,
        start: start.toISOString(),
        end: end.toISOString(),
        feed,
        limit: '10000',
        adjustment: 'raw',
      });
      if (pageToken) params.set('page_token', pageToken);

      const body = await getJson(
        `${config.alpaca.dataUrl}/v2/stocks/bars?${params.toString()}`,
      );
      const bars = (body['bars'] ?? {}) as Record<string, RawBar[]>;

      for (const [symbol, list] of Object.entries(bars)) {
        const existing = merged.get(symbol);
        if (existing) existing.push(...list);
        else merged.set(symbol, [...list]);
      }

      pageToken = (body['next_page_token'] as string | null) ?? null;
    } while (pageToken);
  }

  return merged;
}

/** Completed sessions, most recent last, excluding today. */
export async function fetchRecentSessions(count: number): Promise<string[]> {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - count * 3 - 15);

  const params = new URLSearchParams({
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  });
  const res = await fetch(
    `${config.alpaca.baseUrl}/v2/calendar?${params.toString()}`,
    { headers },
  );
  if (!res.ok) throw new Error(`calendar HTTP ${res.status}`);

  const days = (await res.json()) as { date: string }[];
  const today = new Date().toISOString().slice(0, 10);
  return days.map(d => d.date).filter(d => d < today).slice(-count);
}
