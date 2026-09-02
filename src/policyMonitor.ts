/**
 * Alert-only poller for presidential actions and Trump-related headlines.
 *
 * Off by default. When disabled, start/stop are silent no-ops: no timer, no
 * HTTP, no disk, no log. The trading path never reads this module's state.
 */

import config from './config';
import { createLogger } from './logger';
import { readJson, writeJsonAtomic } from './jsonStore';
import { alertInfo } from './notifier';
import { toErrorMessage } from './utils';
import {
  classifyNewsText,
  classifyPolicyText,
  type PolicyMode,
} from './policyClassifier';
import {
  fetchPresidentialDocuments,
  type FederalRegisterDocument,
} from './federalRegister';
import { fetchRecentPolicyNews } from './policyNews';
import type { NewsHeadline } from './newsProvider';

const log = createLogger('POLICY');

const MAX_CURSOR_IDS = 500;

export interface PolicyAlert {
  source: 'federal_register' | 'news';
  title: string;
  body: string;
  url: string | null;
  hits: readonly string[];
}

export interface PolicyPollPorts {
  mode: PolicyMode;
  cursorPath: string;
  newsLookbackMs: number;
  fetchDocuments: () => Promise<FederalRegisterDocument[]>;
  fetchNews: (start: Date, end: Date) => Promise<NewsHeadline[]>;
  notify: (event: PolicyAlert) => Promise<void>;
  now?: () => Date;
}

interface PolicyCursor {
  federalRegisterIds: string[];
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
    federalRegisterIds: parseIdList(raw['federalRegisterIds']),
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
  const sourceLabel = event.source === 'federal_register' ? 'Federal Register' : 'News';
  const hitLine = event.hits.length > 0 ? `\nHits: ${event.hits.join(', ')}` : '';
  const urlLine = event.url !== null ? `\n${event.url}` : '';
  return {
    title: `Policy — ${sourceLabel}`,
    message: `${event.title}${event.body !== '' ? `\n${event.body}` : ''}${hitLine}${urlLine}`,
  };
}

async function emitAlert(
  event: PolicyAlert,
  notify: PolicyPollPorts['notify'],
): Promise<void> {
  await notify(event);
}

export async function runPolicyPoll(ports: PolicyPollPorts): Promise<void> {
  const now = ports.now !== undefined ? ports.now() : new Date();
  const stored = parseCursor(await readJson(ports.cursorPath));
  const firstRun = stored === null;
  const cursor: PolicyCursor = stored ?? {
    federalRegisterIds: [],
    newsIds: [],
    seededAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  const knownFr = new Set(cursor.federalRegisterIds);
  const knownNews = new Set(cursor.newsIds);
  const seenFr: string[] = [];
  const seenNews: string[] = [];

  try {
    const documents = await ports.fetchDocuments();
    for (const doc of documents) {
      seenFr.push(doc.documentNumber);
      if (firstRun || knownFr.has(doc.documentNumber)) continue;
      const classified = classifyPolicyText(
        `${doc.title}\n${doc.abstract ?? ''}`,
        ports.mode,
      );
      if (!classified.relevant) continue;
      await emitAlert({
        source: 'federal_register',
        title: doc.title,
        body: [doc.subtype, doc.publicationDate].filter(Boolean).join(' · '),
        url: doc.htmlUrl,
        hits: classified.hits,
      }, ports.notify);
    }
  } catch (err: unknown) {
    log.warn(`Federal Register poll skipped: ${toErrorMessage(err)}`);
  }

  try {
    const start = new Date(now.getTime() - ports.newsLookbackMs);
    const headlines = await ports.fetchNews(start, now);
    for (const headline of headlines) {
      seenNews.push(headline.id);
      if (firstRun || knownNews.has(headline.id)) continue;
      const classified = classifyNewsText(
        `${headline.headline}\n${headline.summary ?? ''}`,
        ports.mode,
      );
      if (!classified.relevant) continue;
      await emitAlert({
        source: 'news',
        title: headline.headline,
        body: headline.source ?? '',
        url: headline.url,
        hits: classified.hits,
      }, ports.notify);
    }
  } catch (err: unknown) {
    log.warn(`News poll skipped: ${toErrorMessage(err)}`);
  }

  cursor.federalRegisterIds = prependUnique(cursor.federalRegisterIds, seenFr);
  cursor.newsIds = prependUnique(cursor.newsIds, seenNews);
  cursor.updatedAt = now.toISOString();
  await writeJsonAtomic(ports.cursorPath, cursor);
}

function productionPorts(): PolicyPollPorts {
  const cfg = config.policyMonitor;
  return {
    mode: cfg.mode,
    cursorPath: cfg.cursorPath,
    newsLookbackMs: cfg.newsLookbackMs,
    fetchDocuments: () => fetchPresidentialDocuments({ limit: cfg.federalRegisterLimit }),
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

/**
 * No-op when POLICY_MONITOR_ENABLED is not true. Safe to call from boot
 * on trading and non-trading days alike.
 */
export function startPolicyMonitor(): void {
  if (!config.policyMonitor.enabled) return;
  if (timer !== null) return;
  log.info(
    `Started — mode=${config.policyMonitor.mode} ` +
    `poll=${Math.round(config.policyMonitor.pollIntervalMs / 1000)}s ` +
    `(alert-only, does not trade)`,
  );
  void pollSafe();
  timer = setInterval(() => { void pollSafe(); }, config.policyMonitor.pollIntervalMs);
}

export function stopPolicyMonitor(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}
