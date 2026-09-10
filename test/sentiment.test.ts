import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessBullishCatalyst,
  assessStrictBullishCatalyst,
  classifyHeadline,
  filterWatchlistByBullishCatalyst,
} from '../src/sentiment';
import type { NewsHeadline, NewsProvider } from '../src/newsProvider';
import type { WatchlistSymbol } from '../src/types';

function headline(text: string, id = '1'): NewsHeadline {
  return {
    id,
    headline: text,
    summary: null,
    createdAt: '2026-08-10T12:00:00Z',
    symbols: ['TEST'],
    source: 'fixture',
    url: null,
  };
}

describe('classifyHeadline', () => {
  it('labels upgrade / beats as BULLISH', () => {
    const r = classifyHeadline('Analyst upgrades stock after earnings beat estimates');
    assert.equal(r.sentiment, 'BULLISH');
    assert.ok(r.bullHits >= 1);
    assert.ok(r.score > 0);
  });

  it('labels downgrade / plunge as BEARISH', () => {
    const r = classifyHeadline('Shares plunge after downgrade and guidance cut');
    assert.equal(r.sentiment, 'BEARISH');
    assert.ok(r.bearHits >= 1);
  });

  it('returns NEUTRAL for unrelated headlines', () => {
    const r = classifyHeadline('Company schedules investor day next month');
    assert.equal(r.sentiment, 'NEUTRAL');
    assert.equal(r.score, 0);
  });
});

describe('assessBullishCatalyst', () => {
  it('fails when no headlines', () => {
    const r = assessBullishCatalyst([]);
    assert.equal(r.passes, false);
    assert.equal(r.catalystScore, 0);
  });

  it('fails when only neutral / bearish', () => {
    const r = assessBullishCatalyst([
      headline('Company schedules investor day'),
      headline('Shares plunge on lawsuit news'),
    ]);
    assert.equal(r.passes, false);
  });

  it('passes when at least one bullish headline exists', () => {
    const r = assessBullishCatalyst([
      headline('Quiet trading ahead of holiday'),
      headline('Firm wins contract and raises guidance', '2'),
    ]);
    assert.equal(r.passes, true);
    assert.equal(r.sentiment, 'BULLISH');
    assert.ok(r.catalystScore >= 1);
    assert.ok(r.catalystHeadline?.includes('raises guidance'));
  });
});

describe('assessStrictBullishCatalyst', () => {
  it('fails when a bearish headline sits next to a bullish one (TYRA)', () => {
    const r = assessStrictBullishCatalyst([
      headline('Firm reports positive data from Phase 2 trial'),
      headline('Shares plunge after serious adverse events', '2'),
    ]);
    assert.equal(r.passes, false);
    assert.equal(r.sentiment, 'BEARISH');
  });

  it('passes a clean earnings beat', () => {
    const r = assessStrictBullishCatalyst([
      headline('Company beats estimates and lifts annual profit forecast'),
    ]);
    assert.equal(r.passes, true);
    assert.equal(r.sentiment, 'BULLISH');
  });
});

describe('filterWatchlistByBullishCatalyst', () => {
  it('passthrough when SENTIMENT_FILTER_ENABLED is off (default)', async () => {
    const entries: WatchlistSymbol[] = [
      { symbol: 'AAA', origin: 'V1_CORE' },
      { symbol: 'BBB', origin: 'V1_CORE' },
    ];
    const provider: NewsProvider = {
      getHeadlines: async () => [],
    };
    const out = await filterWatchlistByBullishCatalyst(entries, provider);
    assert.equal(out.length, 2);
  });
});
