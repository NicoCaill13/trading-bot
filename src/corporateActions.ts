import config from './config';
import { createLogger } from './logger';
import { toErrorMessage } from './utils';
import type { AlpacaBar } from '@alpacahq/alpaca-trade-api';

const log = createLogger('CORP_ACTIONS');

const ENDPOINT = 'https://data.alpaca.markets/v1/corporate-actions';
const REQUESTED_TYPES = 'forward_split,reverse_split,stock_dividend';
const PAGE_SIZE = 1000;
const MAX_PAGES = 50;

/**
 * A price-affecting corporate action reduced to a single multiplier.
 *
 * `ratio` is the factor the quoted price was divided by on `exDate`: a 10-for-1
 * forward split carries 10, a 1-for-50 reverse split carries 0.02, a 5% stock
 * dividend carries 1.05. Reducing three event types to one number is what lets
 * `applySplits` stay a single loop.
 */
export interface SplitEvent {
  symbol: string;
  /** YYYY-MM-DD. Bars dated on the ex-date already trade on the new scale. */
  exDate: string;
  ratio: number;
}

/**
 * 'own' means raw bars are fetched and rescaled here; 'alpaca' means the
 * corporate-actions endpoint was unreachable and we defer to the broker's own
 * `adjustment: 'split'`. The mode is part of the EOD cache key: a series built
 * under one mode must never be reused under the other.
 */
export type SplitAdjustmentMode = 'own' | 'alpaca';

export interface SplitIndex {
  readonly mode: SplitAdjustmentMode;
  getSplits(symbol: string): readonly SplitEvent[];
}

export interface CorporateActionsResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

export type CorporateActionsFetcher = (url: string) => Promise<CorporateActionsResponse>;

// ---------------------------------------------------------------------------
// Adjustment
// ---------------------------------------------------------------------------

function scaleBar(bar: AlpacaBar, factor: number): AlpacaBar {
  return {
    ...bar,
    OpenPrice: bar.OpenPrice / factor,
    HighPrice: bar.HighPrice / factor,
    LowPrice: bar.LowPrice / factor,
    ClosePrice: bar.ClosePrice / factor,
    VWAP: bar.VWAP / factor,
    Volume: bar.Volume * factor,
  };
}

/**
 * Rescales raw historical bars onto the current share scale.
 *
 * Walks the series backwards so the cumulative factor accumulates once instead
 * of rescanning every event per bar. Bars are returned in input order and the
 * inputs are never mutated; untouched bars are shared by reference.
 */
export function applySplits(
  bars: readonly AlpacaBar[],
  splits: readonly SplitEvent[],
): AlpacaBar[] {
  if (splits.length === 0 || bars.length === 0) return [...bars];

  const descending = [...splits].sort((a, b) => b.exDate.localeCompare(a.exDate));
  const adjusted: AlpacaBar[] = new Array<AlpacaBar>(bars.length);

  let factor = 1;
  let next = 0;

  for (let i = bars.length - 1; i >= 0; i--) {
    const bar = bars[i];
    const barDay = bar.Timestamp.slice(0, 10);
    while (next < descending.length && descending[next].exDate > barDay) {
      factor *= descending[next].ratio;
      next++;
    }
    adjusted[i] = factor === 1 ? bar : scaleBar(bar, factor);
  }

  return adjusted;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asDay(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function asPositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function asSymbol(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** forward_splits and reverse_splits both carry new_rate / old_rate. */
function parseRateSplits(entries: unknown[]): SplitEvent[] {
  const events: SplitEvent[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    if (!record) continue;
    const symbol = asSymbol(record.symbol);
    const exDate = asDay(record.ex_date);
    const newRate = asPositiveNumber(record.new_rate);
    const oldRate = asPositiveNumber(record.old_rate);
    if (symbol === null || exDate === null || newRate === null || oldRate === null) continue;
    events.push({ symbol, exDate, ratio: newRate / oldRate });
  }
  return events;
}

/** A stock dividend of rate R hands out R extra shares, dividing price by 1 + R. */
function parseStockDividends(entries: unknown[]): SplitEvent[] {
  const events: SplitEvent[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    if (!record) continue;
    const symbol = asSymbol(record.symbol);
    const exDate = asDay(record.ex_date);
    const rate = asPositiveNumber(record.rate);
    if (symbol === null || exDate === null || rate === null) continue;
    events.push({ symbol, exDate, ratio: 1 + rate });
  }
  return events;
}

export function parseCorporateActionsPage(body: unknown): {
  events: SplitEvent[];
  nextPageToken: string | null;
} {
  const root = asRecord(body);
  if (!root) return { events: [], nextPageToken: null };

  const actions = asRecord(root.corporate_actions);
  const events = actions
    ? [
        ...parseRateSplits(asArray(actions.forward_splits)),
        ...parseRateSplits(asArray(actions.reverse_splits)),
        ...parseStockDividends(asArray(actions.stock_dividends)),
      ]
    : [];

  const token = typeof root.next_page_token === 'string' && root.next_page_token.length > 0
    ? root.next_page_token
    : null;

  return { events, nextPageToken: token };
}

// ---------------------------------------------------------------------------
// Index construction
// ---------------------------------------------------------------------------

function buildIndex(mode: SplitAdjustmentMode, events: readonly SplitEvent[]): SplitIndex {
  const bySymbol = new Map<string, SplitEvent[]>();
  for (const event of events) {
    const bucket = bySymbol.get(event.symbol);
    if (bucket) bucket.push(event);
    else bySymbol.set(event.symbol, [event]);
  }
  return {
    mode,
    getSplits: (symbol: string) => bySymbol.get(symbol) ?? [],
  };
}

/** Index used when the endpoint is unreachable: no local rescaling, no events. */
export function alpacaAdjustedIndex(): SplitIndex {
  return buildIndex('alpaca', []);
}

async function defaultFetcher(url: string): Promise<CorporateActionsResponse> {
  const response = await fetch(url, {
    headers: {
      'APCA-API-KEY-ID': config.alpaca.keyId,
      'APCA-API-SECRET-KEY': config.alpaca.secretKey,
    },
  });
  const body: unknown = response.ok ? await response.json() : null;
  return { ok: response.ok, status: response.status, body };
}

function buildPageUrl(startDay: string, endDay: string, pageToken: string | null): string {
  const params = new URLSearchParams({
    types: REQUESTED_TYPES,
    start: startDay,
    end: endDay,
    limit: String(PAGE_SIZE),
  });
  if (pageToken !== null) params.set('page_token', pageToken);
  return `${ENDPOINT}?${params.toString()}`;
}

/**
 * Fetches every price-affecting action in the window once per screener run, so
 * per-symbol adjustment costs no extra API call. Any failure degrades to the
 * broker's own split adjustment rather than aborting the screening: a stale
 * adjustment is recoverable, an empty watchlist is not.
 */
export async function loadSplitIndex(
  startDay: string,
  endDay: string,
  fetcher: CorporateActionsFetcher = defaultFetcher,
): Promise<SplitIndex> {
  const events: SplitEvent[] = [];
  let pageToken: string | null = null;
  let pages = 0;

  try {
    do {
      const response = await fetcher(buildPageUrl(startDay, endDay, pageToken));
      if (!response.ok) {
        log.warn(
          `Corporate actions unavailable (HTTP ${response.status}) — ` +
          'falling back to broker split adjustment',
        );
        return alpacaAdjustedIndex();
      }

      const page = parseCorporateActionsPage(response.body);
      events.push(...page.events);
      pageToken = page.nextPageToken;
      pages++;
    } while (pageToken !== null && pages < MAX_PAGES);
  } catch (err) {
    log.warn(
      `Corporate actions fetch failed (${toErrorMessage(err)}) — ` +
      'falling back to broker split adjustment',
    );
    return alpacaAdjustedIndex();
  }

  if (pageToken !== null) {
    log.warn(`Corporate actions truncated at ${MAX_PAGES} pages — adjustment may be incomplete`);
  }

  log.info(`${events.length} price-affecting action(s) loaded for ${startDay} → ${endDay}`);
  return buildIndex('own', events);
}
