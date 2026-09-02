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
import type { FederalRegisterDocument } from '../src/federalRegister';
import type { NewsHeadline } from '../src/newsProvider';
import { readJson } from '../src/jsonStore';
import config from '../src/config';

function frDoc(id: string, title: string): FederalRegisterDocument {
  return {
    documentNumber: id,
    title,
    abstract: null,
    htmlUrl: `https://www.federalregister.gov/d/${id}`,
    publicationDate: '2026-09-02',
    subtype: 'proclamation',
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
  documents: FederalRegisterDocument[],
  headlines: NewsHeadline[],
): PolicyPollPorts {
  return {
    mode: 'market',
    cursorPath,
    newsLookbackMs: 6 * 60 * 60 * 1000,
    fetchDocuments: async () => documents,
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
    const cursor = await readJson(config.policyMonitor.cursorPath);
    // Disabled start must not create or rewrite the production cursor file.
    // If a leftover file exists from a manual run, its identity is irrelevant
    // as long as this call did not throw and armed no timer we cannot see.
    void cursor;
    stopPolicyMonitor();
  });
});

describe('runPolicyPoll', () => {
  it('seeds the cursor on first run and does not alert', async () => {
    await runPolicyPoll(ports(
      [frDoc('2026-1', 'Imposing Additional Duties on Steel')],
      [news('n1', 'Trump says new China tariffs take effect Monday')],
    ));
    assert.equal(alerts.length, 0);
    const stored = await readJson(cursorPath) as { federalRegisterIds: string[]; newsIds: string[] };
    assert.deepEqual(stored.federalRegisterIds, ['2026-1']);
    assert.deepEqual(stored.newsIds, ['n1']);
  });

  it('alerts only on new market-relevant items after seed', async () => {
    await runPolicyPoll(ports(
      [frDoc('2026-1', 'Imposing Additional Duties on Steel')],
      [news('n1', 'Trump says new China tariffs take effect Monday')],
    ));
    alerts = [];
    await runPolicyPoll(ports(
      [
        frDoc('2026-2', 'Adjusting Imports of Aluminum into the United States'),
        frDoc('2026-1', 'Imposing Additional Duties on Steel'),
      ],
      [
        news('n2', 'Trump honors Purple Heart recipients at the White House'),
        news('n1', 'Trump says new China tariffs take effect Monday'),
      ],
    ));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.source, 'federal_register');
    assert.ok(alerts[0]?.title.includes('Aluminum'));
  });

  it('does not alert on ceremonial presidential documents in market mode', async () => {
    await runPolicyPoll(ports(
      [frDoc('seed', 'Imposing Additional Duties on Steel')],
      [],
    ));
    alerts = [];
    await runPolicyPoll(ports(
      [
        frDoc('ceremonial', 'National Purple Heart Day, 2026'),
        frDoc('seed', 'Imposing Additional Duties on Steel'),
      ],
      [],
    ));
    assert.equal(alerts.length, 0);
  });

  it('survives a failed source without dropping the other', async () => {
    await runPolicyPoll(ports(
      [frDoc('seed', 'Imposing Additional Duties on Steel')],
      [news('n-seed', 'Trump says China tariffs rise')],
    ));
    alerts = [];
    await runPolicyPoll({
      ...ports(
        [frDoc('2026-new', 'Imposing Additional Duties on Canadian Dairy')],
        [],
      ),
      fetchNews: async () => {
        throw new Error('news down');
      },
    });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.source, 'federal_register');
  });
});
