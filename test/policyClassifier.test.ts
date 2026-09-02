import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyNewsText,
  classifyPolicyText,
  isTrumpRelatedNews,
} from '../src/policyClassifier';

describe('classifyPolicyText', () => {
  it('keeps tariff / import proclamations in market mode', () => {
    const r = classifyPolicyText(
      'Imposing Additional Duties to Offset Canadian Discrimination Against Dairy',
      'market',
    );
    assert.equal(r.relevant, true);
    assert.ok(r.hits.includes('duties'));
  });

  it('does not treat "important" as an import hit', () => {
    const r = classifyPolicyText(
      'An important day for American veterans',
      'market',
    );
    assert.equal(r.relevant, false);
  });

  it('drops ceremonial proclamations in market mode', () => {
    const r = classifyPolicyText(
      'Honoring the American History of the Great Lakes and Renaming Lake Ontario',
      'market',
    );
    assert.equal(r.relevant, false);
    assert.equal(r.hits.length, 0);
  });

  it('keeps ceremonial titles in all mode', () => {
    const r = classifyPolicyText('National Purple Heart Day, 2026', 'all');
    assert.equal(r.relevant, true);
    assert.equal(r.hits.length, 0);
  });
});

describe('classifyNewsText', () => {
  it('requires a Trump marker before applying the market lexicon', () => {
    const r = classifyNewsText('Steel tariffs rise after EU complaint', 'market');
    assert.equal(r.relevant, false);
  });

  it('alerts on Trump + tariff headlines', () => {
    const r = classifyNewsText(
      'Trump says new China tariffs take effect Monday',
      'market',
    );
    assert.equal(r.relevant, true);
    assert.ok(r.hits.includes('tariff') || r.hits.includes('tariffs') || r.hits.includes('china'));
  });

  it('ignores Trump posts without a market term in market mode', () => {
    const r = classifyNewsText('Trump honors Purple Heart recipients at the White House', 'market');
    assert.equal(r.relevant, false);
  });
});

describe('isTrumpRelatedNews', () => {
  it('matches Truth Social and White House copy', () => {
    assert.equal(isTrumpRelatedNews('New Truth Social post hits the tape'), true);
    assert.equal(isTrumpRelatedNews('White House announces proclamation'), true);
    assert.equal(isTrumpRelatedNews('Apple reports earnings'), false);
  });
});
