/**
 * Trump *trade* classifier. Policy / tariff / ceremonial copy is out of scope.
 * A headline must name Trump and describe a securities transaction.
 */

export interface PolicyClassification {
  relevant: boolean;
  hits: readonly string[];
}

const TRUMP_PERSON_TERMS = [
  'donald trump',
  'trump jr',
  'donald j. trump',
  'president trump',
  'eric trump',
] as const;

const TRADE_VERBS = [
  'bought',
  'buys',
  'buy',
  'sold',
  'sells',
  'sell',
  'purchase',
  'purchased',
  'acquired',
  'disposed',
  'form 4',
  'form4',
  'insider transaction',
  'opened a position',
  'periodic transaction',
] as const;

const SECURITY_NOUNS = [
  'share',
  'shares',
  'stock',
  'stake',
  'equity',
  'position',
  'insider',
  'form 4',
  'form4',
  'djt',
  'filing',
] as const;

function hasTerm(haystack: string, term: string): boolean {
  if (term.includes(' ')) return haystack.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`).test(haystack);
}

function collectHits(haystack: string, terms: readonly string[]): string[] {
  return terms.filter(term => hasTerm(haystack, term));
}

export function isTrumpPersonMention(text: string): boolean {
  const haystack = text.toLowerCase();
  if (TRUMP_PERSON_TERMS.some(term => haystack.includes(term))) return true;
  // Bare "trump" is accepted only next to a trade verb, to avoid "trump card"
  // and White House policy copy. "Trump Media" + sold shares still qualifies.
  return hasTerm(haystack, 'trump');
}

export function classifyTrumpTradeNews(text: string): PolicyClassification {
  const haystack = text.toLowerCase();
  if (!isTrumpPersonMention(text)) {
    return { relevant: false, hits: [] };
  }
  const verbs = collectHits(haystack, TRADE_VERBS);
  const nouns = collectHits(haystack, SECURITY_NOUNS);
  if (verbs.length === 0 || nouns.length === 0) {
    return { relevant: false, hits: [...verbs, ...nouns] };
  }
  return { relevant: true, hits: [...verbs, ...nouns] };
}
