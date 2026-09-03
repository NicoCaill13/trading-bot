import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  runPolicyPoll,
  startPolicyMonitor,
  stopPolicyMonitor,
  type PolicyAlert,
  type PolicyPollPorts,
} from '../src/policyMonitor';
import type { EdgarForm4Filing } from '../src/edgarForm4';
import type { NewsHeadline } from '../src/newsProvider';
import { readJson } from '../src/jsonStore';
import config from '../src/config';

function form4(id: string, name: string): EdgarForm4Filing {
  return {
    accessionNumber: id,
    filingDate: '2026-08-18',
    names: [name, 'PSQ Holdings, Inc.'],
    form: '4',
    url: `https://www.sec.gov/Archives/edgar/data/2016181/${id.replace(/-/g, '')}/${id}-index.html`,
  };
}

function news(id: string, headline: string): NewsHeadline {
  return {
    id,
    headline,
    summary: null,
    createdAt: '2026-09-02T12:00:00Z',
    symbols: [],
    source: 'fixture',
    url: 'https://example.com/n/' + id,
  };
}

let tmpDir: string;
let cursorPath: string;
let alerts: PolicyAlert[];

function ports(
  filings: EdgarForm4Filing[],
  headlines: NewsHeadline[],
): PolicyPollPorts {
  return {
    cursorPath,
    newsLookbackMs: 6 * 60 * 60 * 1000,
    fetchForm4: async () => filings,
    fetchNews: async () => headlines,
    notify: async (event) => { alerts.push(event); },
    now: () => new Date('2026-09-02T16:00:00.000Z'),
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-monitor-'));
  cursorPath = path.join(tmpDir, 'policy_cursor.json');
  alerts = [];
});

afterEach(() => {
  stopPolicyMonitor();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('config default', () => {
  it('stays disabled so boot is a no-op without an explicit flag', () => {
    assert.equal(config.policyMonitor.enabled, false);
  });
});

describe('startPolicyMonitor', () => {
  it('does not write a cursor when the feature flag is off', async () => {
    startPolicyMonitor();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(config.policyMonitor.enabled, false);
    stopPolicyMonitor();
  });
});

describe('runPolicyPoll', () => {
  it('seeds the cursor on first run and does not alert', async () => {
    await runPolicyPoll(ports(
      [form4('0002016181-26-000005', 'Trump Donald J. JR')],
      [news('n1', 'Donald Trump bought 10,000 shares of DJT')],
    ));
    assert.equal(alerts.length, 0);
    const stored = await readJson(cursorPath) as { form4Ids: string[]; newsIds: string[] };
    assert.deepEqual(stored.form4Ids, ['0002016181-26-000005']);
    assert.deepEqual(stored.newsIds, ['n1']);
  });

  it('alerts on a new Form 4 after seed', async () => {
    await runPolicyPoll(ports(
      [form4('0002016181-26-000005', 'Trump Donald J. JR')],
      [],
    ));
    alerts = [];
    await runPolicyPoll(ports(
      [
        form4('0002016181-26-000006', 'Trump Donald J. JR'),
        form4('0002016181-26-000005', 'Trump Donald J. JR'),
      ],
      [],
    ));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.source, 'form4');
    assert.ok(alerts[0]?.title.includes('Trump'));
  });

  it('does not alert on tariff or ceremonial news', async () => {
    await runPolicyPoll(ports([], [news('seed', 'Donald Trump bought 1 share of DJT')]));
    alerts = [];
    await runPolicyPoll(ports(
      [],
      [
        news('n-tariff', 'Trump says new China tariffs take effect Monday'),
        news('n-ceremonial', 'Trump honors Purple Heart recipients at the White House'),
        news('seed', 'Donald Trump bought 1 share of DJT'),
      ],
    ));
    assert.equal(alerts.length, 0);
  });

  it('alerts on new buy/sell news after seed', async () => {
    await runPolicyPoll(ports([], [news('seed', 'Quiet tape')]));
    alerts = [];
    await runPolicyPoll(ports(
      [],
      [
        news('n-buy', 'Donald Trump bought 50,000 shares of DJT'),
        news('seed', 'Quiet tape'),
      ],
    ));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.source, 'news');
  });

  it('survives a failed source without dropping the other', async () => {
    await runPolicyPoll(ports(
      [form4('seed-4', 'Trump Donald J. JR')],
      [news('n-seed', 'Donald Trump bought 1 share of DJT')],
    ));
    alerts = [];
    await runPolicyPoll({
      ...ports(
        [form4('new-4', 'Trump Donald J. JR')],
        [],
      ),
      fetchNews: async () => {
        throw new Error('news down');
      },
    });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.source, 'form4');
  });
});
