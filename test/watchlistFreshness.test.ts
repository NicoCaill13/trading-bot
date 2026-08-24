import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isWatchlistCurrent,
  resolveRequiredWatchlistTradingDay,
} from '../src/watchlistFreshness';

const SCREENER_MINUTES = 20 * 60;

describe('resolveRequiredWatchlistTradingDay', () => {
  it('requires the previous session before the EOD screener on a trading day', () => {
    assert.equal(
      resolveRequiredWatchlistTradingDay({
        todayNy: '2026-08-19',
        todayIsTrading: true,
        minutesSinceMidnight: 10 * 60,
        screenerMinutes: SCREENER_MINUTES,
        previousTradingDay: '2026-08-18',
      }),
      '2026-08-18',
    );
  });

  it('requires today from screener time onward on a trading day', () => {
    assert.equal(
      resolveRequiredWatchlistTradingDay({
        todayNy: '2026-08-18',
        todayIsTrading: true,
        minutesSinceMidnight: SCREENER_MINUTES,
        screenerMinutes: SCREENER_MINUTES,
        previousTradingDay: '2026-08-17',
      }),
      '2026-08-18',
    );
  });

  it('keeps the previous session on a weekend', () => {
    assert.equal(
      resolveRequiredWatchlistTradingDay({
        todayNy: '2026-08-22',
        todayIsTrading: false,
        minutesSinceMidnight: 22 * 60,
        screenerMinutes: SCREENER_MINUTES,
        previousTradingDay: '2026-08-21',
      }),
      '2026-08-21',
    );
  });

  it('returns null when the previous session is unknown before screener time', () => {
    assert.equal(
      resolveRequiredWatchlistTradingDay({
        todayNy: '2026-08-19',
        todayIsTrading: true,
        minutesSinceMidnight: 10 * 60,
        screenerMinutes: SCREENER_MINUTES,
        previousTradingDay: null,
      }),
      null,
    );
  });

  it('ignores the previous Core list before 09:15 when evening screener is off', () => {
    assert.equal(
      resolveRequiredWatchlistTradingDay({
        todayNy: '2026-08-24',
        todayIsTrading: true,
        minutesSinceMidnight: 5 * 60 + 21,
        screenerMinutes: SCREENER_MINUTES,
        previousTradingDay: '2026-08-21',
        eveningScreenerEnabled: false,
        preMarketMinutes: 9 * 60 + 15,
      }),
      null,
    );
  });

  it('requires today after 09:15 when evening screener is off', () => {
    assert.equal(
      resolveRequiredWatchlistTradingDay({
        todayNy: '2026-08-24',
        todayIsTrading: true,
        minutesSinceMidnight: 9 * 60 + 15,
        screenerMinutes: SCREENER_MINUTES,
        previousTradingDay: '2026-08-21',
        eveningScreenerEnabled: false,
        preMarketMinutes: 9 * 60 + 15,
      }),
      '2026-08-24',
    );
  });

  it('has no live universe on a weekend when evening screener is off', () => {
    assert.equal(
      resolveRequiredWatchlistTradingDay({
        todayNy: '2026-08-22',
        todayIsTrading: false,
        minutesSinceMidnight: 12 * 60,
        screenerMinutes: SCREENER_MINUTES,
        previousTradingDay: '2026-08-21',
        eveningScreenerEnabled: false,
        preMarketMinutes: 9 * 60 + 15,
      }),
      null,
    );
  });
});

describe('isWatchlistCurrent', () => {
  it('rejects a missing file', () => {
    assert.equal(isWatchlistCurrent(null, '2026-08-18'), false);
  });

  it('rejects a file without tradingDay (legacy watchlist)', () => {
    assert.equal(
      isWatchlistCurrent({ symbols: [{ symbol: 'AAPL' }] }, '2026-08-18'),
      false,
    );
  });

  it('rejects an empty symbol list even on the right day', () => {
    assert.equal(
      isWatchlistCurrent({ tradingDay: '2026-08-18', symbols: [] }, '2026-08-18'),
      false,
    );
  });

  it('rejects a J-2 list on the next session', () => {
    assert.equal(
      isWatchlistCurrent(
        { tradingDay: '2026-08-17', symbols: [{ symbol: 'AAPL' }] },
        '2026-08-18',
      ),
      false,
    );
  });

  it('accepts a list stamped with the required day', () => {
    assert.equal(
      isWatchlistCurrent(
        { tradingDay: '2026-08-18', symbols: [{ symbol: 'AAPL' }] },
        '2026-08-18',
      ),
      true,
    );
  });

  it('fails closed when the required day is unknown', () => {
    assert.equal(
      isWatchlistCurrent(
        { tradingDay: '2026-08-18', symbols: [{ symbol: 'AAPL' }] },
        null,
      ),
      false,
    );
  });
});
