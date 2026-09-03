/**
 * SEC EDGAR full-text search for Form 4 filings that name Donald J. Trump.
 * Official, keyless, free. Requires a descriptive User-Agent (SEC policy).
 */

import { createLogger } from './logger';
import { toErrorMessage } from './utils';

const log = createLogger('POLICY');

const EFTS_URL = 'https://efts.sec.gov/LATEST/search-index';
const DEFAULT_QUERY = '"Trump Donald J"';
const FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_UA = 'trading-bot policy-monitor (personal research)';

export interface EdgarForm4Filing {
  accessionNumber: string;
  filingDate: string;
  names: readonly string[];
  form: string;
  url: string;
}

export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function filingIndexUrl(ciks: readonly string[], adsh: string): string {
  const rawCik = ciks[0] ?? '0';
  const cikNum = String(Number.parseInt(rawCik, 10));
  const acc = adsh.replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${cikNum}/${acc}/${adsh}-index.html`;
}

export function parseEdgarForm4Hit(raw: unknown): EdgarForm4Filing | null {
  if (!isRecord(raw)) return null;
  const source = isRecord(raw['_source']) ? raw['_source'] : raw;
  const adsh = optionalString(source['adsh']);
  const filingDate = optionalString(source['file_date']);
  const form = optionalString(source['form']) ?? optionalString(source['file_type']);
  if (adsh === null || filingDate === null) return null;
  if (form !== null && form !== '4' && form !== '4/A') return null;
  const namesRaw = source['display_names'];
  const names = Array.isArray(namesRaw)
    ? namesRaw.filter((n): n is string => typeof n === 'string' && n.trim() !== '')
    : [];
  const ciksRaw = source['ciks'];
  const ciks = Array.isArray(ciksRaw)
    ? ciksRaw.filter((c): c is string => typeof c === 'string')
    : [];
  return {
    accessionNumber: adsh,
    filingDate,
    names,
    form: form ?? '4',
    url: filingIndexUrl(ciks, adsh),
  };
}

export function parseEdgarSearchPayload(json: unknown): EdgarForm4Filing[] {
  if (!isRecord(json)) return [];
  const hitsWrap = isRecord(json['hits']) ? json['hits'] : null;
  const hits = hitsWrap !== null && Array.isArray(hitsWrap['hits']) ? hitsWrap['hits'] : [];
  const filings: EdgarForm4Filing[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const parsed = parseEdgarForm4Hit(hit);
    if (parsed === null || seen.has(parsed.accessionNumber)) continue;
    seen.add(parsed.accessionNumber);
    filings.push(parsed);
  }
  return filings;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function fetchTrumpForm4Filings(
  opts: {
    lookbackDays?: number;
    now?: Date;
    fetcher?: FetchLike;
    userAgent?: string;
    query?: string;
  } = {},
): Promise<EdgarForm4Filing[]> {
  const lookbackDays = Math.min(90, Math.max(1, opts.lookbackDays ?? 30));
  const now = opts.now ?? new Date();
  const start = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const url = new URL(EFTS_URL);
  url.searchParams.set('q', opts.query ?? DEFAULT_QUERY);
  url.searchParams.set('forms', '4');
  url.searchParams.set('dateRange', 'custom');
  url.searchParams.set('startdt', isoDate(start));
  url.searchParams.set('enddt', isoDate(now));

  const fetcher = opts.fetcher ?? fetch;
  try {
    const res = await fetcher(url.toString(), {
      headers: {
        Accept: 'application/json',
        'User-Agent': opts.userAgent ?? DEFAULT_UA,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const json: unknown = await res.json();
    return parseEdgarSearchPayload(json);
  } catch (err: unknown) {
    log.warn(`EDGAR Form 4 search failed: ${toErrorMessage(err)}`);
    throw err;
  }
}
