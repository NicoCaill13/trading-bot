import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAdrPct,
  isAllowedExchange,
  passesAdrGate,
  passesClosePrice,
  passesDollarVolume,
  passesFloatGate,
  sumShareVolume,
  type OhlcBar,
} from '../src/screenerMath';

function bar(high: number, low: number, close: number): OhlcBar {
  return { high, low, close };
}

describe('computeAdrPct', () => {
  it('averages ((H-L)/C)*100 over lookback', () => {
    // Day1: (12-10)/10*100 = 20; Day2: (11-10)/10*100 = 10 → ADR = 15
    const bars = [bar(12, 10, 10), bar(11, 10, 10)];
    assert.equal(computeAdrPct(bars, 2), 15);
  });

  it('uses only the last N bars', () => {
    const bars = [bar(20, 10, 10), bar(11, 10, 10), bar(11, 10, 10)];
    // last 2: 10 + 10 → 10
    assert.equal(computeAdrPct(bars, 2), 10);
  });

  it('returns null when history is insufficient', () => {
    assert.equal(computeAdrPct([bar(11, 10, 10)], 2), null);
  });

  it('returns null when a close is non-positive', () => {
    assert.equal(computeAdrPct([bar(11, 10, 10), bar(11, 10, 0)], 2), null);
  });
});

describe('passesAdrGate', () => {
  it('rejects ADR at or below the floor', () => {
    assert.equal(passesAdrGate(4.0, 4.0), false);
    assert.equal(passesAdrGate(3.9, 4.0), false);
  });

  it('accepts ADR strictly above the floor', () => {
    assert.equal(passesAdrGate(4.01, 4.0), true);
  });
});

describe('passesClosePrice + passesDollarVolume', () => {
  it('enforces price floor', () => {
    assert.equal(passesClosePrice(5, 5), true);
    assert.equal(passesClosePrice(4.99, 5), false);
  });

  it('enforces dollar volume via close * volume', () => {
    assert.equal(passesDollarVolume(10, 2_000_000, 20_000_000), true);
    assert.equal(passesDollarVolume(10, 1_999_999, 20_000_000), false);
  });
});

describe('passesFloatGate', () => {
  it('accepts float inside [10M, 500M]', () => {
    assert.equal(passesFloatGate(10_000_000, 10_000_000, 500_000_000), true);
    assert.equal(passesFloatGate(500_000_000, 10_000_000, 500_000_000), true);
  });

  it('rejects float outside the band', () => {
    assert.equal(passesFloatGate(9_999_999, 10_000_000, 500_000_000), false);
    assert.equal(passesFloatGate(500_000_001, 10_000_000, 500_000_000), false);
  });
});

describe('isAllowedExchange', () => {
  const allowed = ['NYSE', 'NASDAQ'] as const;

  it('accepts NYSE and NASDAQ case-insensitively', () => {
    assert.equal(isAllowedExchange('NYSE', allowed), true);
    assert.equal(isAllowedExchange('nasdaq', allowed), true);
  });

  it('rejects ARCA / AMEX / empty', () => {
    assert.equal(isAllowedExchange('ARCA', allowed), false);
    assert.equal(isAllowedExchange('AMEX', allowed), false);
    assert.equal(isAllowedExchange('', allowed), false);
  });
});

describe('sumShareVolume', () => {
  it('sums positive volumes', () => {
    assert.equal(sumShareVolume([{ volume: 100 }, { volume: 200 }, { volume: -1 }]), 300);
  });
});
