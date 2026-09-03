/**
 * Alert-only poller for Trump-family securities trades.
 *
 * Sources: SEC Form 4 (EDGAR) + Alpaca headlines that describe a buy/sell.
 * Federal Register / tariff / ceremonial copy is not a trade and is ignored.
 *
 * Off by default. When disabled, start/stop are silent no-ops.
 */

import config from './config';
import { createLogger } from './logger';
import { readJson, writeJsonAtomic } from './jsonStore';
import { alertInfo } from './notifier';
import { toErrorMessage } from './utils';
import { classifyTrumpTradeNews } from './policyClassifier';
import { fetchTrumpForm4Filings, type EdgarForm4Filing } from './edgarForm4';
import { fetchRecentPolicyNews } from './policyNews';
import type { NewsHeadline } from './newsProvider';

const log = createLogger('POLICY');

const MAX_CURSOR_IDS = 500;

export interface PolicyAlert {
  source: 'form4' | 'news';
  title: string;
  body: string;
  url: string | null;
  hits: readonly string[];
}

export interface PolicyPollPorts {
  cursorPath: string;
  newsLookbackMs: number;
  fetchForm4: () => Promise<EdgarForm4Filing[]>;
  fetchNews: (start: Date, end: Date) => Promise<NewsHeadline[]>;
  notify: (event: PolicyAlert) => Promise<void>;
  now?: () => Date;
}

interface PolicyCursor {
  form4Ids: string[];
  newsIds: string[];
  seededAt: string;
  updatedAt: string;
}

let timer: ReturnType<typeof setInterval> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function parseCursor(raw: unknown): PolicyCursor | null {
  if (!isRecord(raw)) return null;
  const seededAt = typeof raw['seededAt'] === 'string' ? raw['seededAt'] : null;
  const updatedAt = typeof raw['updatedAt'] === 'string' ? raw['updatedAt'] : null;
  if (seededAt === null || updatedAt === null) return null;
  return {
    form4Ids: parseIdList(raw['form4Ids']),
    newsIds: parseIdList(raw['newsIds']),
    seededAt,
    updatedAt,
  };
}

function prependUnique(existing: readonly string[], incoming: readonly string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const id of [...incoming, ...existing]) {
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(id);
    if (merged.length >= MAX_CURSOR_IDS) break;
  }
  return merged;
}

function formatAlert(event: PolicyAlert): { title: string; message: string } {
  const sourceLabel = event.source === 'form4' ? 'Form 4' : 'News';
  const hitLine = event.hits.length > 0 ? `\nHits: ${event.hits.join(', ')}` : '';
  const urlLine = event.url !== null ? `\n${event.url}` : '';
  return {
    title: `Trump trade — ${sourceLabel}`,
    message: `${event.title}${event.body !== '' ? `\n${event.body}` : ''}${hitLine}${urlLine}`,
  };
}

export async function runPolicyPoll(ports: PolicyPollPorts): Promise<void> {
  const now = ports.now !== undefined ? ports.now() : new Date();
  const stored = parseCursor(await readJson(ports.cursorPath));
  const cursor: PolicyCursor = stored ?? {
    form4Ids: [],
    newsIds: [],
    seededAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  const knownForm4 = new Set(cursor.form4Ids);
  const knownNews = new Set(cursor.newsIds);
  const seedForm4 = cursor.form4Ids.length === 0;
  const seedNews = cursor.newsIds.length === 0;
  const seenForm4: string[] = [];
  const seenNews: string[] = [];

  try {
    const filings = await ports.fetchForm4();
    for (const filing of filings) {
      seenForm4.push(filing.accessionNumber);
      if (seedForm4 || knownForm4.has(filing.accessionNumber)) continue;
      await ports.notify({
        source: 'form4',
        title: filing.names[0] ?? `Form ${filing.form} ${filing.accessionNumber}`,
        body: `${filing.names.slice(1).join(' · ')}${filing.names.length > 1 ? '\n' : ''}Filed: ${filing.filingDate}`,
        url: filing.url,
        hits: ['form 4'],
      });
    }
  } catch (err: unknown) {
    log.warn(`Form 4 poll skipped: ${toErrorMessage(err)}`);
  }

  try {
    const start = new Date(now.getTime() - ports.newsLookbackMs);
    const headlines = await ports.fetchNews(start, now);
    for (const headline of headlines) {
      seenNews.push(headline.id);
      if (seedNews || knownNews.has(headline.id)) continue;
      const classified = classifyTrumpTradeNews(
        `${headline.headline}\n${headline.summary ?? ''}`,
      );
      if (!classified.relevant) continue;
      await ports.notify({
        source: 'news',
        title: headline.headline,
        body: headline.source ?? '',
        url: headline.url,
        hits: classified.hits,
      });
    }
  } catch (err: unknown) {
    log.warn(`News poll skipped: ${toErrorMessage(err)}`);
  }

  cursor.form4Ids = prependUnique(cursor.form4Ids, seenForm4);
  cursor.newsIds = prependUnique(cursor.newsIds, seenNews);
  cursor.updatedAt = now.toISOString();
  await writeJsonAtomic(ports.cursorPath, cursor);
}

function productionPorts(): PolicyPollPorts {
  const cfg = config.policyMonitor;
  return {
    cursorPath: cfg.cursorPath,
    newsLookbackMs: cfg.newsLookbackMs,
    fetchForm4: () => fetchTrumpForm4Filings({
      lookbackDays: cfg.form4LookbackDays,
      userAgent: cfg.secUserAgent,
    }),
    fetchNews: (start, end) => fetchRecentPolicyNews(start, end, { limit: cfg.newsLimit }),
    async notify(event: PolicyAlert): Promise<void> {
      const formatted = formatAlert(event);
      log.info(`${formatted.title} — ${event.title}`);
      await alertInfo(formatted.title, formatted.message);
    },
  };
}

async function pollSafe(): Promise<void> {
  try {
    await runPolicyPoll(productionPorts());
  } catch (err: unknown) {
    log.warn(`Policy poll failed: ${toErrorMessage(err)}`);
  }
}

export function startPolicyMonitor(): void {
  if (!config.policyMonitor.enabled) return;
  if (timer !== null) return;
  log.info(
    `Started — Trump trades only (Form 4 + buy/sell news) ` +
    `poll=${Math.round(config.policyMonitor.pollIntervalMs / 1000)}s`,
  );
  void pollSafe();
  timer = setInterval(() => { void pollSafe(); }, config.policyMonitor.pollIntervalMs);
}

export function stopPolicyMonitor(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}
