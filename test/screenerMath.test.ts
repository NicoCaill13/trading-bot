import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  comparePremarketRank,
  compareWatchlistRank,
  compareOpeningExtensionRank,
  computeAdrPct,
  computeOpeningExtensionPct,
  isAllowedExchange,
  isEtfLikeProduct,
  isOpeningExtensionInBand,
  passesAdrGate,
  passesClosePrice,
  passesDollarVolume,
  passesDollarVolumeBand,
  passesOpeningExtensionGates,
  passesPremarketPricePair,
  passesPriceBand,
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

  it('enforces an inclusive [min, max] price band', () => {
    assert.equal(passesPriceBand(5, 5, 50), true);
    assert.equal(passesPriceBand(50, 5, 50), true);
    assert.equal(passesPriceBand(4.99, 5, 50), false);
    assert.equal(passesPriceBand(50.01, 5, 50), false);
  });

  it('enforces dollar volume via close * volume', () => {
    assert.equal(passesDollarVolume(10, 2_000_000, 20_000_000), true);
    assert.equal(passesDollarVolume(10, 1_999_999, 20_000_000), false);
  });
});

describe('passesPremarketPricePair', () => {
  it('accepts a name whose print and previous close are both in band', () => {
    assert.equal(passesPremarketPricePair(9.38, 9.17, 5, 100), true);
  });

  it('rejects a print in-band sitting on a penny previous close (GRML)', () => {
    assert.equal(passesPremarketPricePair(8.52, 0.203, 5, 100), false);
  });

  it('rejects a previous close above the cap (MRNA)', () => {
    assert.equal(passesPremarketPricePair(144.03, 138.82, 5, 100), false);
  });
});

describe('comparePremarketRank', () => {
  it('ranks higher dollar volume ahead of a larger gap', () => {
    const ranked = [
      { dollarVolume: 1_000_000, gapPct: 40 },
      { dollarVolume: 20_000_000, gapPct: 0.04 },
    ].sort(comparePremarketRank);
    assert.equal(ranked[0]?.dollarVolume, 20_000_000);
  });

  it('breaks a dollar-volume tie on gap', () => {
    const ranked = [
      { dollarVolume: 10_000_000, gapPct: 0.03 },
      { dollarVolume: 10_000_000, gapPct: 0.08 },
    ].sort(comparePremarketRank);
    assert.equal(ranked[0]?.gapPct, 0.08);
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

describe('isEtfLikeProduct', () => {
  it('rejects the NASDAQ ETFs that filled the 27/08 watchlist', () => {
    assert.equal(isEtfLikeProduct({ name: 'ProShares UltraPro Short QQQ' }), true);
    assert.equal(isEtfLikeProduct({ name: 'ProShares UltraPro QQQ' }), true);
    assert.equal(
      isEtfLikeProduct({
        name: 'Direxion Shares ETF Trust Direxion Daily TSLA Bull 2X ETF',
      }),
      true,
    );
    assert.equal(isEtfLikeProduct({ name: 'iShares Bitcoin Trust ETF Shares' }), true);
    assert.equal(isEtfLikeProduct({ name: 'iShares Ethereum Trust ETF Shares' }), true);
    assert.equal(isEtfLikeProduct({ name: 'Invesco QQQ Trust, Series 1' }), true);
  });

  it('keeps common stock / corporate names from the same tape', () => {
    assert.equal(isEtfLikeProduct({ name: 'Intel Corporation Common Stock' }), false);
    assert.equal(isEtfLikeProduct({ name: 'American Airlines Group Inc. Common Stock' }), false);
    assert.equal(isEtfLikeProduct({ name: 'BitMine Immersion Technologies, Inc.' }), false);
    assert.equal(isEtfLikeProduct({ name: 'Circle Internet Group, Inc.' }), false);
    assert.equal(isEtfLikeProduct({ name: 'Invesco Ltd. Common Stock' }), false);
  });

  it('fails closed on a missing name and on an explicit etf attribute', () => {
    assert.equal(isEtfLikeProduct({ name: '' }), true);
    assert.equal(isEtfLikeProduct({ name: 'Mystery Co', attributes: ['etf'] }), true);
  });
});

describe('sumShareVolume', () => {
  it('sums positive volumes', () => {
    assert.equal(sumShareVolume([{ volume: 100 }, { volume: 200 }, { volume: -1 }]), 300);
  });
});

describe('compareWatchlistRank', () => {
  it('ranks higher alpha first even with a weaker gap', () => {
    const ranked = [
      { relativeReturn: 0.01, relativeVolume: 3, gapUp: 0.10 },
      { relativeReturn: 0.05, relativeVolume: 0.5, gapUp: -0.01 },
    ].sort(compareWatchlistRank);
    assert.equal(ranked[0]?.relativeReturn, 0.05);
  });

  it('breaks an alpha tie on RVOL then gap', () => {
    const ranked = [
      { relativeReturn: 0.02, relativeVolume: 1.0, gapUp: 0.08 },
      { relativeReturn: 0.02, relativeVolume: 1.4, gapUp: 0.00 },
    ].sort(compareWatchlistRank);
    assert.equal(ranked[0]?.relativeVolume, 1.4);
  });
});

const extensionGates = {
  minPrice: 5,
  maxPrice: 100,
  minExtensionPct: 0.01,
  minRthDollarVolume: 100_000,
};

describe('computeOpeningExtensionPct + passesOpeningExtensionGates', () => {
  it('accepts PATH 27/08 (+6.9% from the open, in-band)', () => {
    assert.equal(computeOpeningExtensionPct(18.23, 17.055)?.toFixed(4), '0.0689');
    assert.equal(
      passesOpeningExtensionGates(
        { last: 18.23, sessionOpen: 17.055, previousClose: 16.75, rthDollarVolume: 2_800_000 },
        extensionGates,
      ),
      true,
    );
  });

  it('rejects a name still at or below the open (long-only)', () => {
    assert.equal(
      passesOpeningExtensionGates(
        { last: 38.22, sessionOpen: 38.47, previousClose: 39.4, rthDollarVolume: 7_000_000 },
        extensionGates,
      ),
      false,
    );
  });

  it('rejects a sub-1% drift even with mega dollar volume (INTC-like)', () => {
    assert.equal(
      passesOpeningExtensionGates(
        { last: 90.0, sessionOpen: 89.615, previousClose: 88.25, rthDollarVolume: 36_000_000 },
        { ...extensionGates, minExtensionPct: 0.021 },
      ),
      false,
    );
  });
});

describe('compareOpeningExtensionRank', () => {
  it('ranks PATH / ASAN / CLSK ahead of INTC / TQQQ / SQQQ / AAL', () => {
    const ranked = [
      { symbol: 'INTC', extensionPct: 0.0205, rthDollarVolume: 36_000_000 },
      { symbol: 'TQQQ', extensionPct: 0.0068, rthDollarVolume: 8_000_000 },
      { symbol: 'SQQQ', extensionPct: 0.0073, rthDollarVolume: 7_000_000 },
      { symbol: 'AAL', extensionPct: 0.0065, rthDollarVolume: 750_000 },
      { symbol: 'PATH', extensionPct: 0.0689, rthDollarVolume: 2_800_000 },
      { symbol: 'ASAN', extensionPct: 0.0480, rthDollarVolume: 300_000 },
      { symbol: 'CLSK', extensionPct: 0.0221, rthDollarVolume: 366_000 },
      { symbol: 'WULF', extensionPct: 0.0203, rthDollarVolume: 1_900_000 },
    ].sort(compareOpeningExtensionRank);
    const order = ranked.map(r => r.symbol);
    assert.deepEqual(order.slice(0, 3), ['PATH', 'ASAN', 'CLSK']);
    // WULF +2.03% vs INTC +2.05%: extension-first ranking keeps INTC just ahead.
    assert.ok(order.indexOf('INTC') < order.indexOf('TQQQ'));
    assert.ok(order.indexOf('WULF') < order.indexOf('TQQQ'));
    assert.deepEqual(order.slice(-3), ['SQQQ', 'TQQQ', 'AAL']);
  });
});

describe('isOpeningExtensionInBand — entry vs 09:30 open', () => {
  const min = 0.025;
  const max = 0.055;

  it('keeps ASAN 26/08 (+4.8%) and DOCS 31/08 (+4.0%) inside the hold band', () => {
    assert.equal(isOpeningExtensionInBand(0.0480, min, max), true);
    assert.equal(isOpeningExtensionInBand(0.0400, min, max), true);
  });

  it('rejects AI / SNAP / SLB-class drift under 2.5%', () => {
    assert.equal(isOpeningExtensionInBand(0.015, min, max), false);
    assert.equal(isOpeningExtensionInBand(0.014, min, max), false);
    assert.equal(isOpeningExtensionInBand(0.0085, min, max), false);
  });

  it('rejects the vertical 09:30 wick (BRZE / HNGE / PATH print) — wait for a return', () => {
    assert.equal(isOpeningExtensionInBand(0.084, min, max), false);
    assert.equal(isOpeningExtensionInBand(0.072, min, max), false);
    assert.equal(isOpeningExtensionInBand(0.0689, min, max), false);
    assert.equal(isOpeningExtensionInBand(0.058, min, max), false);
  });

  it('fails closed on a null extension', () => {
    assert.equal(isOpeningExtensionInBand(null, min, max), false);
  });
});

describe('passesDollarVolumeBand', () => {
  it('keeps CHPT SIP $8.5M above a $5M floor', () => {
    assert.equal(passesDollarVolumeBand(8_463_494, 5_000_000, 0), true);
  });

  it('rejects IEX-scale $265k under the same floor', () => {
    assert.equal(passesDollarVolumeBand(265_212, 5_000_000, 0), false);
  });

  it('rejects above an optional ceiling', () => {
    assert.equal(passesDollarVolumeBand(1_800_000_000, 5_000_000, 800_000_000), false);
    assert.equal(passesDollarVolumeBand(741_738_190, 5_000_000, 800_000_000), true);
  });
});

