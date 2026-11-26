/**
 * Research-only EDGAR access: throttled, retrying, and cached on disk so a
 * re-run never hits sec.gov twice for the same company. Delete the cache
 * directory to refresh. Requests carry the User-Agent the caller supplies, as
 * SEC fair-access policy requires.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createThrottle, sleep } from './throttle';

const CACHE_DIR = './data/study_earnings/edgar';
const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
/** SEC fair access allows 10 requests per second; stay under it. */
const MIN_REQUEST_INTERVAL_MS = 150;
const MAX_ATTEMPTS = 5;
const FETCH_TIMEOUT_MS = 30_000;

export interface EdgarClient {
  tickerMap: () => Promise<unknown>;
  epsConcept: (cik: string) => Promise<unknown>;
  submissions: (cik: string) => Promise<unknown>;
}

export function createEdgarClient(userAgent: string): EdgarClient {
  const throttle = createThrottle(MIN_REQUEST_INTERVAL_MS);

  /** Parsed JSON, or null when the company does not report the requested concept (404). */
  async function fetchJson(url: string): Promise<unknown> {
    let backoffMs = 1_000;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await throttle();
      const res = await fetch(url, {
        headers: { 'User-Agent': userAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) {
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 30_000);
        continue;
      }
      if (!res.ok) {
        const hint = res.status === 403 ? ' (sec.gov rejected the User-Agent)' : '';
        throw new Error(`EDGAR HTTP ${res.status}${hint}: ${url}`);
      }
      return (await res.json()) as unknown;
    }
    throw new Error(`EDGAR still failing after ${MAX_ATTEMPTS} attempts: ${url}`);
  }

  async function cached(key: string, url: string): Promise<unknown> {
    const file = path.join(CACHE_DIR, `${key}.json`);
    try {
      return JSON.parse(await readFile(file, 'utf8')) as unknown;
    } catch {
      // Cache miss or unreadable file: fetch again.
    }
    const body = await fetchJson(url);
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(file, JSON.stringify(body));
    return body;
  }

  return {
    tickerMap: () => cached('tickers', TICKERS_URL),
    epsConcept: cik => cached(
      `concept_${cik}`,
      `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/EarningsPerShareDiluted.json`,
    ),
    submissions: cik => cached(`subs_${cik}`, `https://data.sec.gov/submissions/CIK${cik}.json`),
  };
}
