/**
 * Multi-symbol daily bars over raw REST. The SDK fetches one ticker at a time,
 * which cannot sweep the tradable universe inside the 09:15 window.
 *
 * Kept in src/ so the live eligible pool can use SIP previous-session volume
 * instead of the IEX-scale PrevDailyBar that getSnapshots returns (no feed
 * query param in SDK 3.1.x).
 */

import config from './config';

export type DataFeed = 'iex' | 'sip';

export interface DailyBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface DailyLiquidity {
  previousClose: number;
  previousVolume: number;
}

const SYMBOL_BATCH_SIZE = 800;
const MAX_ATTEMPTS = 8;
const MIN_REQUEST_INTERVAL_MS = 340;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

let nextRequestAt = 0;

async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, nextRequestAt - now);
  nextRequestAt = Math.max(now, nextRequestAt) + MIN_REQUEST_INTERVAL_MS;
  if (wait > 0) await sleep(wait);
}

function authHeaders(): Record<string, string> {
  return {
    'APCA-API-KEY-ID': config.alpaca.keyId,
    'APCA-API-SECRET-KEY': config.alpaca.secretKey,
  };
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  let backoffMs = 1_000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await throttle();
    const res = await fetch(url, { headers: authHeaders() });

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

export async function fetchDailyBars(
  symbols: readonly string[],
  start: Date,
  end: Date,
  feed: DataFeed,
): Promise<Map<string, DailyBar[]>> {
  const merged = new Map<string, DailyBar[]>();

  for (let i = 0; i < symbols.length; i += SYMBOL_BATCH_SIZE) {
    const batch = symbols.slice(i, i + SYMBOL_BATCH_SIZE);
    let pageToken: string | null = null;

    do {
      const params = new URLSearchParams({
        symbols: batch.join(','),
        timeframe: '1Day',
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
      const bars = (body['bars'] ?? {}) as Record<string, DailyBar[]>;

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

/**
 * Last completed daily bar strictly before `cutoff`. Used as previous-session
 * close and volume for the 09:15 pool.
 */
export function lastDailyBefore(
  bars: readonly DailyBar[],
  cutoffMs: number,
): DailyLiquidity | null {
  let found: DailyBar | null = null;
  for (const bar of [...bars].sort((a, b) => Date.parse(a.t) - Date.parse(b.t))) {
    if (Date.parse(bar.t) >= cutoffMs) break;
    found = bar;
  }
  if (found === null || !(found.c > 0) || !(found.v > 0)) return null;
  return { previousClose: found.c, previousVolume: found.v };
}

export function dailyLiquidityBySymbol(
  barsBySymbol: ReadonlyMap<string, DailyBar[]>,
  cutoffMs: number,
): Map<string, DailyLiquidity> {
  const out = new Map<string, DailyLiquidity>();
  for (const [symbol, bars] of barsBySymbol) {
    const liq = lastDailyBefore(bars, cutoffMs);
    if (liq !== null) out.set(symbol, liq);
  }
  return out;
}
