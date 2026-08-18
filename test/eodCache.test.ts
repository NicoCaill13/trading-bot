import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import config from '../src/config';
import { readEodBars, writeEodBars } from '../src/eodCache';
import type { AlpacaBar } from '@alpacahq/alpaca-trade-api';

// Far-future sentinel: cannot collide with a real screener run in data/eod.
const TRADING_DAY = '2099-01-02';
const START_DAY = '2098-01-02';

function bar(day: string, close: number): AlpacaBar {
  return {
    Symbol: 'TEST',
    Timestamp: `${day}T05:00:00Z`,
    OpenPrice: close,
    HighPrice: close,
    LowPrice: close,
    ClosePrice: close,
    VWAP: close,
    Volume: 1_000,
    TradeCount: 10,
  };
}

const BARS = [bar('2098-12-30', 99), bar('2099-01-02', 101)];

afterEach(async () => {
  await fs.rm(path.resolve(config.paths.eodCache, TRADING_DAY), {
    recursive: true,
    force: true,
  });
});

describe('eodCache', () => {
  it('returns null on a cold cache', async () => {
    assert.equal(await readEodBars(TRADING_DAY, 'COLD', START_DAY, 'own'), null);
  });

  it('round-trips a series', async () => {
    await writeEodBars(TRADING_DAY, 'TEST', START_DAY, 'own', BARS);
    assert.deepEqual(await readEodBars(TRADING_DAY, 'TEST', START_DAY, 'own'), BARS);
  });

  it('supports dotted symbols', async () => {
    await writeEodBars(TRADING_DAY, 'BRK.B', START_DAY, 'own', BARS);
    assert.deepEqual(await readEodBars(TRADING_DAY, 'BRK.B', START_DAY, 'own'), BARS);
  });

  it('misses when the window start differs', async () => {
    await writeEodBars(TRADING_DAY, 'TEST', START_DAY, 'own', BARS);
    assert.equal(await readEodBars(TRADING_DAY, 'TEST', '2097-06-01', 'own'), null);
  });

  it('misses when the adjustment mode differs', async () => {
    await writeEodBars(TRADING_DAY, 'TEST', START_DAY, 'own', BARS);
    assert.equal(await readEodBars(TRADING_DAY, 'TEST', START_DAY, 'alpaca'), null);
  });

  it('misses when the trading day differs', async () => {
    await writeEodBars(TRADING_DAY, 'TEST', START_DAY, 'own', BARS);
    assert.equal(await readEodBars('2099-01-03', 'TEST', START_DAY, 'own'), null);
  });

  it('refuses symbols that could escape the cache root', async () => {
    await writeEodBars(TRADING_DAY, '../../etc/passwd', START_DAY, 'own', BARS);
    assert.equal(await readEodBars(TRADING_DAY, '../../etc/passwd', START_DAY, 'own'), null);
  });

  it('ignores a corrupt entry rather than throwing', async () => {
    await writeEodBars(TRADING_DAY, 'TEST', START_DAY, 'own', BARS);
    const recordPath = path.resolve(config.paths.eodCache, TRADING_DAY, 'TEST.json');
    await fs.writeFile(recordPath, '{ truncated');

    assert.equal(await readEodBars(TRADING_DAY, 'TEST', START_DAY, 'own'), null);
  });

  it('ignores an entry whose bars fail validation', async () => {
    const recordPath = path.resolve(config.paths.eodCache, TRADING_DAY, 'TEST.json');
    await fs.mkdir(path.dirname(recordPath), { recursive: true });
    await fs.writeFile(
      recordPath,
      JSON.stringify({
        symbol: 'TEST',
        tradingDay: TRADING_DAY,
        startDay: START_DAY,
        adjustment: 'own',
        bars: [{ Timestamp: '2098-12-30T05:00:00Z', ClosePrice: 'oops' }],
      }),
    );

    assert.equal(await readEodBars(TRADING_DAY, 'TEST', START_DAY, 'own'), null);
  });

  it('leaves no temporary file behind', async () => {
    await writeEodBars(TRADING_DAY, 'TEST', START_DAY, 'own', BARS);
    const entries = await fs.readdir(path.resolve(config.paths.eodCache, TRADING_DAY));
    assert.deepEqual(entries, ['TEST.json']);
  });
});
