import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AlpacaSnapshot } from '@alpacahq/alpaca-trade-api';
import {
  isScannerClockWindow,
  rankOpeningMovers,
  scanSessionExtension,
  snapshotToOpeningMover,
  type OpeningMover,
} from '../src/openingScanner';

const GATES = {
  minPrice: 5,
  maxPrice: 100,
  minExtensionPct: 0.01,
  minRthDollarVolume: 100_000,
  maxSymbols: 4,
  pinned: new Set<string>(),
};

function snap(opts: {
  symbol: string;
  last: number;
  open: number;
  prev: number;
  volume: number;
}): AlpacaSnapshot {
  return {
    Symbol: opts.symbol,
    LatestTrade: { Price: opts.last },
    DailyBar: {
      Symbol: opts.symbol,
      OpenPrice: opts.open,
      HighPrice: opts.last,
      LowPrice: opts.open,
      ClosePrice: opts.last,
      Volume: opts.volume,
      Timestamp: '2026-08-27T13:35:00Z',
      VWAP: opts.last,
      TradeCount: 1,
    },
    PrevDailyBar: {
      Symbol: opts.symbol,
      OpenPrice: opts.prev,
      HighPrice: opts.prev,
      LowPrice: opts.prev,
      ClosePrice: opts.prev,
      Volume: 1_000_000,
      Timestamp: '2026-08-26T20:00:00Z',
      VWAP: opts.prev,
      TradeCount: 1,
    },
  };
}

describe('snapshotToOpeningMover', () => {
  it('derives extension from DailyBar open and latest trade', () => {
    const mover = snapshotToOpeningMover(
      snap({ symbol: 'PATH', last: 18.23, open: 17.055, prev: 16.75, volume: 163_244 }),
    );
    assert.ok(mover);
    assert.equal(mover.symbol, 'PATH');
    assert.ok(Math.abs(mover.extensionPct - (18.23 - 17.055) / 17.055) < 1e-9);
  });
});

describe('rankOpeningMovers', () => {
  const week: OpeningMover[] = [
    { symbol: 'PATH', last: 18.23, sessionOpen: 17.055, previousClose: 16.75, rthDollarVolume: 2_800_000, extensionPct: 0.0689 },
    { symbol: 'ASAN', last: 10.15, sessionOpen: 9.69, previousClose: 9.43, rthDollarVolume: 300_000, extensionPct: 0.0480 },
    { symbol: 'INTC', last: 91.45, sessionOpen: 89.615, previousClose: 88.25, rthDollarVolume: 36_000_000, extensionPct: 0.0205 },
    { symbol: 'TQQQ', last: 72.6, sessionOpen: 72.11, previousClose: 70.45, rthDollarVolume: 8_000_000, extensionPct: 0.0068 },
    { symbol: 'SQQQ', last: 38.75, sessionOpen: 38.47, previousClose: 39.4, rthDollarVolume: 7_000_000, extensionPct: 0.0073 },
  ];

  it('keeps PATH and ASAN in the cap and drops TQQQ (below 1%)', () => {
    const selected = rankOpeningMovers(week, GATES);
    assert.deepEqual(selected.map(s => s.symbol), ['PATH', 'ASAN', 'INTC']);
  });

  it('excludes pinned names from ranking but keeps them in the universe', () => {
    const selected = rankOpeningMovers(week, {
      ...GATES,
      maxSymbols: 3,
      pinned: new Set(['INTC']),
    });
    assert.equal(selected[0]?.symbol, 'INTC');
    assert.deepEqual(selected.map(s => s.symbol), ['INTC', 'PATH', 'ASAN']);
  });

  it('respects maxSymbols', () => {
    const selected = rankOpeningMovers(week, { ...GATES, maxSymbols: 1 });
    assert.deepEqual(selected.map(s => s.symbol), ['PATH']);
  });
});

describe('scanSessionExtension', () => {
  it('ranks mock snapshots through the injected client', async () => {
    const snapshots = [
      snap({ symbol: 'PATH', last: 18.23, open: 17.055, prev: 16.75, volume: 200_000 }),
      snap({ symbol: 'AAL', last: 13.9, open: 13.81, prev: 13.84, volume: 5_000 }),
    ];
    const selected = await scanSessionExtension(
      [{ symbol: 'PATH', previousClose: 16.75, lastPrice: 17.0, prevDollarVolume: 20_000_000 },
       { symbol: 'AAL', previousClose: 13.84, lastPrice: 13.81, prevDollarVolume: 20_000_000 }],
      { getSnapshots: async () => snapshots },
      GATES,
    );
    assert.equal(selected[0]?.symbol, 'PATH');
    assert.equal(selected.some(s => s.symbol === 'AAL'), false);
  });
});

describe('isScannerClockWindow', () => {
  const start = 9 * 60 + 31;
  const end = 11 * 60 + 30;

  it('opens at 09:31 and stays open past the OD window through 11:30', () => {
    assert.equal(isScannerClockWindow(9 * 60 + 31, start, end), true);
    assert.equal(isScannerClockWindow(10 * 60, start, end), true);
    assert.equal(isScannerClockWindow(11 * 60 + 30, start, end), true);
  });

  it('is closed before 09:31 and after 11:30', () => {
    assert.equal(isScannerClockWindow(9 * 60 + 30, start, end), false);
    assert.equal(isScannerClockWindow(11 * 60 + 31, start, end), false);
  });
});
