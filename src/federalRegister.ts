/**
 * Federal Register presidential documents. Official, keyless JSON API.
 * Alert-only — never called from the order path.
 */

import { toErrorMessage } from './utils';
import { createLogger } from './logger';

const log = createLogger('POLICY');

const DEFAULT_URL = 'https://www.federalregister.gov/api/v1/documents.json';
const FETCH_TIMEOUT_MS = 15_000;

export interface FederalRegisterDocument {
  documentNumber: string;
  title: string;
  abstract: string | null;
  htmlUrl: string | null;
  publicationDate: string;
  subtype: string | null;
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

export function parseFederalRegisterDocument(raw: unknown): FederalRegisterDocument | null {
  if (!isRecord(raw)) return null;
  const documentNumber = optionalString(raw['document_number']);
  const title = optionalString(raw['title']);
  if (documentNumber === null || title === null) return null;
  return {
    documentNumber,
    title,
    abstract: optionalString(raw['abstract']),
    htmlUrl: optionalString(raw['html_url']),
    publicationDate: optionalString(raw['publication_date']) ?? '',
    subtype: optionalString(raw['presidential_document_type'])
      ?? optionalString(raw['subtype']),
  };
}

export function parseFederalRegisterPayload(json: unknown): FederalRegisterDocument[] {
  if (!isRecord(json)) return [];
  const results = json['results'];
  if (!Array.isArray(results)) return [];
  const documents: FederalRegisterDocument[] = [];
  for (const row of results) {
    const parsed = parseFederalRegisterDocument(row);
    if (parsed !== null) documents.push(parsed);
  }
  return documents;
}

export async function fetchPresidentialDocuments(
  opts: { limit?: number; fetcher?: FetchLike; baseUrl?: string } = {},
): Promise<FederalRegisterDocument[]> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
  const fetcher = opts.fetcher ?? fetch;
  const url = new URL(opts.baseUrl ?? DEFAULT_URL);
  url.searchParams.set('per_page', String(limit));
  url.searchParams.set('order', 'newest');
  url.searchParams.append('conditions[type][]', 'PRESDOCU');

  try {
    const res = await fetcher(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const json: unknown = await res.json();
    return parseFederalRegisterPayload(json);
  } catch (err: unknown) {
    log.warn(`Federal Register fetch failed: ${toErrorMessage(err)}`);
    throw err;
  }
}
