/**
 * Pure lexicon for the policy monitor. No I/O — Federal Register titles and
 * news headlines are classified the same way so the poller stays a thin loop.
 *
 * `market` keeps ceremonial proclamations out. `all` is a debug dump.
 */

export type PolicyMode = 'market' | 'all';

export interface PolicyClassification {
  relevant: boolean;
  hits: readonly string[];
}

const MARKET_TERMS = [
  'tariff',
  'tariffs',
  'duty',
  'duties',
  'imports',
  'import',
  'exports',
  'export',
  'trade war',
  'section 232',
  'section 301',
  'ieepa',
  'reciprocal',
  'sanctions',
  'embargo',
  'china',
  'chinese',
  'mexico',
  'canada',
  'steel',
  'aluminum',
  'aluminium',
  'oil',
  'crude',
  'opec',
  'iran',
  'gasoline',
  'energy',
  'semiconductor',
  'chip',
  'rare earth',
  'auto',
  'automobile',
  'federal reserve',
  'interest rate',
  'fomc',
  'truth social',
  'djt',
] as const;

const TRUMP_NEWS_MARKERS = [
  'trump',
  'white house',
  'truth social',
  'president donald',
] as const;

function hasTerm(haystack: string, term: string): boolean {
  if (term.includes(' ')) return haystack.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`).test(haystack);
}

export function classifyPolicyText(text: string, mode: PolicyMode): PolicyClassification {
  const haystack = text.toLowerCase();
  const hits = MARKET_TERMS.filter(term => hasTerm(haystack, term));
  if (mode === 'all') {
    return { relevant: true, hits };
  }
  return { relevant: hits.length > 0, hits };
}

export function isTrumpRelatedNews(text: string): boolean {
  const haystack = text.toLowerCase();
  return TRUMP_NEWS_MARKERS.some(marker => haystack.includes(marker));
}

export function classifyNewsText(text: string, mode: PolicyMode): PolicyClassification {
  if (!isTrumpRelatedNews(text)) {
    return { relevant: false, hits: [] };
  }
  return classifyPolicyText(text, mode);
}
