import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NewsHeadline } from '../src/newsProvider';
import { classifyNews, groupBySymbol } from '../scripts/lib/eligibleNews';

function headline(text: string, symbols: string[], id = text): NewsHeadline {
  return {
    id,
    headline: text,
    summary: null,
    createdAt: '2026-09-01T12:00:00Z',
    symbols,
    source: null,
    url: null,
  };
}

describe('classifyNews', () => {
  it('reports none when there is no headline', () => {
    assert.equal(classifyNews([]), 'none');
  });

  it('reports bullish for a bullish headline with nothing bearish', () => {
    assert.equal(classifyNews([headline('ACME surges on earnings beat', ['ACME'])]), 'bullish');
  });

  it('fails closed on a mixed tape', () => {
    const mixed = [
      headline('ACME surges on positive data', ['ACME']),
      headline('ACME faces lawsuit over trial', ['ACME']),
    ];
    assert.equal(classifyNews(mixed), 'other');
  });

  it('reports other for headlines without a bullish term', () => {
    assert.equal(classifyNews([headline('ACME to present at conference', ['ACME'])]), 'other');
  });
});

describe('groupBySymbol', () => {
  const articles = [
    headline('one', ['AAA']),
    headline('two', ['AAA', 'BBB']),
    headline('three', ['CCC']),
  ];

  it('assigns a multi-symbol article to each requested symbol', () => {
    const grouped = groupBySymbol(articles, ['AAA', 'BBB']);
    assert.equal(grouped.get('AAA')?.length, 2);
    assert.equal(grouped.get('BBB')?.length, 1);
  });

  it('ignores symbols that were not requested', () => {
    const grouped = groupBySymbol(articles, ['AAA']);
    assert.equal(grouped.has('CCC'), false);
    assert.equal(grouped.has('BBB'), false);
  });

  it('returns nothing for a symbol with no articles', () => {
    assert.equal(groupBySymbol(articles, ['ZZZ']).size, 0);
  });
});
