/**
 * Pure parsers for the three EDGAR payloads the earnings study reads. Each takes
 * untyped JSON and keeps only well-formed rows, so a malformed entry is dropped
 * rather than trusted.
 */

import { isRecord } from '../../src/utils';
import type { EpsFact } from './earningsSurprise';

export interface Filing {
  form: string;
  /** Filing date, YYYY-MM-DD. */
  filed: string;
  /** Acceptance instant, ISO 8601 UTC. */
  acceptedAt: string;
  /** Comma-separated 8-K item numbers, empty for other forms. */
  items: string;
}

const asList = (value: unknown): readonly unknown[] => (Array.isArray(value) ? (value as unknown[]) : []);

/** Ticker to zero-padded 10-digit CIK, from company_tickers.json. */
export function parseTickerMap(json: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!isRecord(json)) return map;
  for (const entry of Object.values(json)) {
    if (!isRecord(entry)) continue;
    const ticker = entry['ticker'];
    const cik = entry['cik_str'];
    if (typeof ticker !== 'string' || typeof cik !== 'number') continue;
    map.set(ticker.toUpperCase(), String(cik).padStart(10, '0'));
  }
  return map;
}

/** Alpaca writes share classes as BRK.B, EDGAR as BRK-B. */
export function cikForSymbol(map: ReadonlyMap<string, string>, symbol: string): string | null {
  const upper = symbol.toUpperCase();
  return map.get(upper) ?? map.get(upper.replace('.', '-')) ?? null;
}

/** Diluted EPS facts from a companyconcept payload (unit USD/shares). */
export function parseEpsFacts(json: unknown): EpsFact[] {
  const units = isRecord(json) ? json['units'] : undefined;
  const rows = isRecord(units) ? asList(units['USD/shares']) : [];
  const facts: EpsFact[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const { start, end, val, filed, form } = row;
    if (
      typeof start === 'string' && typeof end === 'string' && typeof val === 'number' &&
      typeof filed === 'string' && typeof form === 'string'
    ) {
      facts.push({ start, end, val, filed, form });
    }
  }
  return facts;
}

/** Recent filings from a submissions payload (parallel arrays flattened to rows). */
export function parseFilings(json: unknown): Filing[] {
  const filings = isRecord(json) ? json['filings'] : undefined;
  const recent = isRecord(filings) ? filings['recent'] : undefined;
  if (!isRecord(recent)) return [];

  const forms = asList(recent['form']);
  const dates = asList(recent['filingDate']);
  const accepted = asList(recent['acceptanceDateTime']);
  const items = asList(recent['items']);

  const out: Filing[] = [];
  forms.forEach((form, i) => {
    const filed = dates[i];
    const acceptedAt = accepted[i];
    const itemList = items[i];
    if (typeof form !== 'string' || typeof filed !== 'string' || typeof acceptedAt !== 'string') return;
    out.push({ form, filed, acceptedAt, items: typeof itemList === 'string' ? itemList : '' });
  });
  return out;
}
