import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTrumpTradeNews,
  isTrumpPersonMention,
} from '../src/policyClassifier';

describe('classifyTrumpTradeNews', () => {
  it('alerts on Trump buying shares', () => {
    const r = classifyTrumpTradeNews('Donald Trump bought 50,000 shares of DJT');
    assert.equal(r.relevant, true);
    assert.ok(r.hits.includes('bought'));
    assert.ok(r.hits.includes('shares'));
  });

  it('alerts on a Form 4 headline', () => {
    const r = classifyTrumpTradeNews('Trump Jr files Form 4 after DJT stock purchase');
    assert.equal(r.relevant, true);
  });

  it('drops tariff / policy headlines', () => {
    const r = classifyTrumpTradeNews(
      'Trump says new China tariffs take effect Monday',
    );
    assert.equal(r.relevant, false);
  });

  it('drops ceremonial White House copy', () => {
    const r = classifyTrumpTradeNews(
      'Trump honors Purple Heart recipients at the White House',
    );
    assert.equal(r.relevant, false);
  });

  it('drops a sale with no security noun', () => {
    const r = classifyTrumpTradeNews('Trump sold the idea to Congress');
    assert.equal(r.relevant, false);
  });

  it('drops a steel-tariff story with no Trump person trade', () => {
    const r = classifyTrumpTradeNews('Steel tariffs rise after EU complaint');
    assert.equal(r.relevant, false);
  });
});

describe('isTrumpPersonMention', () => {
  it('matches Donald Trump and rejects unrelated names', () => {
    assert.equal(isTrumpPersonMention('Donald Trump bought stock'), true);
    assert.equal(isTrumpPersonMention('Apple reports earnings'), false);
  });
});
