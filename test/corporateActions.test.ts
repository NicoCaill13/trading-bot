import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySplits,
  loadSplitIndex,
  parseCorporateActionsPage,
  type CorporateActionsResponse,
  type SplitEvent,
} from '../src/corporateActions';
import type { AlpacaBar } from '@alpacahq/alpaca-trade-api';

function bar(day: string, close: number, volume = 1_000): AlpacaBar {
  return {
    Symbol: 'TEST',
    Timestamp: `${day}T04:00:00Z`,
    OpenPrice: close,
    HighPrice: close,
    LowPrice: close,
    ClosePrice: close,
    VWAP: close,
    Volume: volume,
    TradeCount: 10,
  };
}

const FORWARD_10_1: SplitEvent = { symbol: 'TEST', exDate: '2025-11-17', ratio: 10 };

describe('applySplits', () => {
  it('returns a copy when there is no event', () => {
    const bars = [bar('2026-08-17', 100)];
    const result = applySplits(bars, []);
    assert.deepEqual(result, bars);
    assert.notEqual(result, bars);
  });

  it('rescales bars strictly before the ex-date', () => {
    const bars = [
      bar('2025-11-14', 1_200),
      bar('2025-11-17', 120),
      bar('2025-11-18', 125),
    ];

    const [before, onExDate, after] = applySplits(bars, [FORWARD_10_1]);

    assert.equal(before.ClosePrice, 120);
    assert.equal(onExDate.ClosePrice, 120);
    assert.equal(after.ClosePrice, 125);
  });

  it('inflates volume by the same factor it deflates price', () => {
    const [adjusted] = applySplits([bar('2025-11-14', 1_200, 500)], [FORWARD_10_1]);
    assert.equal(adjusted.ClosePrice, 120);
    assert.equal(adjusted.Volume, 5_000);
  });

  it('compounds several events across the series', () => {
    const bars = [
      bar('2025-01-02', 400),
      bar('2025-06-02', 40),
      bar('2026-01-02', 20),
    ];
    const splits: SplitEvent[] = [
      { symbol: 'TEST', exDate: '2025-06-02', ratio: 10 },
      { symbol: 'TEST', exDate: '2026-01-02', ratio: 2 },
    ];

    const result = applySplits(bars, splits);

    assert.equal(result[0].ClosePrice, 20);
    assert.equal(result[1].ClosePrice, 20);
    assert.equal(result[2].ClosePrice, 20);
  });

  it('handles a reverse split as a ratio below one', () => {
    const [adjusted] = applySplits(
      [bar('2023-08-23', 0.4)],
      [{ symbol: 'TEST', exDate: '2023-08-24', ratio: 1 / 50 }],
    );
    assert.equal(Math.round(adjusted.ClosePrice), 20);
  });

  it('does not mutate the input bars', () => {
    const bars = [bar('2025-11-14', 1_200)];
    applySplits(bars, [FORWARD_10_1]);
    assert.equal(bars[0].ClosePrice, 1_200);
  });

  it('is order-independent on the event list', () => {
    const bars = [bar('2025-01-02', 400), bar('2026-01-02', 20)];
    const ascending: SplitEvent[] = [
      { symbol: 'TEST', exDate: '2025-06-02', ratio: 10 },
      { symbol: 'TEST', exDate: '2026-01-02', ratio: 2 },
    ];
    const descending = [...ascending].reverse();

    assert.deepEqual(applySplits(bars, ascending), applySplits(bars, descending));
  });
});

describe('parseCorporateActionsPage', () => {
  it('normalises forward splits, reverse splits and stock dividends', () => {
    const page = parseCorporateActionsPage({
      corporate_actions: {
        forward_splits: [
          { symbol: 'NFLX', ex_date: '2025-11-17', new_rate: 10, old_rate: 1 },
        ],
        reverse_splits: [
          { symbol: 'MNTS', ex_date: '2023-08-24', new_rate: 1, old_rate: 50 },
        ],
        stock_dividends: [
          { symbol: 'MSBC', ex_date: '2023-05-19', rate: 0.05 },
        ],
      },
      next_page_token: null,
    });

    assert.equal(page.nextPageToken, null);
    assert.deepEqual(page.events, [
      { symbol: 'NFLX', exDate: '2025-11-17', ratio: 10 },
      { symbol: 'MNTS', exDate: '2023-08-24', ratio: 0.02 },
      { symbol: 'MSBC', exDate: '2023-05-19', ratio: 1.05 },
    ]);
  });

  it('drops malformed entries instead of throwing', () => {
    const page = parseCorporateActionsPage({
      corporate_actions: {
        forward_splits: [
          { symbol: 'A', ex_date: '2025-11-17', new_rate: 0, old_rate: 1 },
          { symbol: 'B', ex_date: 'not-a-date', new_rate: 2, old_rate: 1 },
          { ex_date: '2025-11-17', new_rate: 2, old_rate: 1 },
          null,
        ],
      },
      next_page_token: '',
    });

    assert.deepEqual(page.events, []);
    assert.equal(page.nextPageToken, null);
  });

  it('tolerates an unexpected payload shape', () => {
    assert.deepEqual(parseCorporateActionsPage(null).events, []);
    assert.deepEqual(parseCorporateActionsPage('nope').events, []);
    assert.deepEqual(parseCorporateActionsPage({}).events, []);
  });
});

describe('loadSplitIndex', () => {
  const ok = (body: unknown): CorporateActionsResponse => ({ ok: true, status: 200, body });

  it('groups events by symbol', async () => {
    const index = await loadSplitIndex('2025-01-01', '2026-08-18', async () =>
      ok({
        corporate_actions: {
          forward_splits: [
            { symbol: 'NFLX', ex_date: '2025-11-17', new_rate: 10, old_rate: 1 },
            { symbol: 'SMCI', ex_date: '2024-10-01', new_rate: 10, old_rate: 1 },
          ],
        },
        next_page_token: null,
      }),
    );

    assert.equal(index.mode, 'own');
    assert.equal(index.getSplits('NFLX').length, 1);
    assert.equal(index.getSplits('SMCI').length, 1);
    assert.deepEqual(index.getSplits('AAPL'), []);
  });

  it('follows pagination until the token is exhausted', async () => {
    const pages = [
      ok({
        corporate_actions: {
          forward_splits: [{ symbol: 'A', ex_date: '2025-01-02', new_rate: 2, old_rate: 1 }],
        },
        next_page_token: 'page-2',
      }),
      ok({
        corporate_actions: {
          forward_splits: [{ symbol: 'B', ex_date: '2025-01-03', new_rate: 3, old_rate: 1 }],
        },
        next_page_token: null,
      }),
    ];
    let calls = 0;

    const index = await loadSplitIndex('2025-01-01', '2026-08-18', async () => pages[calls++]);

    assert.equal(calls, 2);
    assert.equal(index.getSplits('B').length, 1);
  });

  it('falls back to broker adjustment on a denied request', async () => {
    const index = await loadSplitIndex('2025-01-01', '2026-08-18', async () => ({
      ok: false,
      status: 403,
      body: null,
    }));

    assert.equal(index.mode, 'alpaca');
    assert.deepEqual(index.getSplits('NFLX'), []);
  });

  it('falls back to broker adjustment when the fetch throws', async () => {
    const index = await loadSplitIndex('2025-01-01', '2026-08-18', async () => {
      throw new Error('ENOTFOUND');
    });

    assert.equal(index.mode, 'alpaca');
  });
});
