import https from 'https';
import { URL } from 'url';
import { createLogger } from './logger';
import { sendTelegramAlert } from './notificationManager';
import type { DiscordField, DailyReportData } from './types';

const log = createLogger('NOTIFIER');

const COLOR = {
  SUCCESS:  0x2ECC71,
  CRITICAL: 0xE74C3C,
  INFO:     0x3498DB,
} as const;

type ColorValue = typeof COLOR[keyof typeof COLOR];

interface DiscordEmbed {
  title: string;
  description: string;
  color: ColorValue;
  fields: DiscordField[];
  timestamp: string;
  footer: { text: string };
}

interface DiscordPayload {
  embeds: DiscordEmbed[];
}

// ---------------------------------------------------------------------------
// Generic HTTPS transport — zero external deps (Discord only)
// ---------------------------------------------------------------------------

function postJson(urlStr: string, payload: DiscordPayload): Promise<void> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(urlStr);
    } catch {
      log.warn(`Invalid webhook URL: ${urlStr}`);
      return resolve();
    }

    const body = JSON.stringify(payload);
    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 8000,
    };

    const req = https.request(options, (res) => {
      res.resume();
      if (res.statusCode !== undefined && res.statusCode >= 400) {
        log.warn(`Webhook HTTP ${res.statusCode} for ${parsed.hostname}`);
      }
      resolve();
    });

    req.on('error', (err: Error) => {
      log.warn(`Webhook network error: ${err.message}`);
      resolve();
    });

    req.on('timeout', () => {
      req.destroy();
      log.warn('Webhook timeout (8s)');
      resolve();
    });

    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

async function sendDiscord(
  title: string,
  description: string,
  color: ColorValue,
  fields: DiscordField[] = [],
): Promise<void> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;

  const embed: DiscordEmbed = {
    title,
    description,
    color,
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: 'Trading Bot — Paper' },
  };

  await postJson(url, { embeds: [embed] });
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export async function alertCritical(
  title: string,
  message: string,
  fields: DiscordField[] = [],
): Promise<void> {
  log.error(`[CRITICAL ALERT] ${title} — ${message}`);
  await Promise.all([
    sendDiscord(`🚨 ${title}`, message, COLOR.CRITICAL, fields),
    sendTelegramAlert(`<b>🚨 CRITICAL — ${title}</b>\n${message}`),
  ]);
}

export async function alertInfo(
  title: string,
  message: string,
  fields: DiscordField[] = [],
): Promise<void> {
  log.info(`[NOTIFICATION] ${title} — ${message}`);
  await Promise.all([
    sendDiscord(`ℹ️ ${title}`, message, COLOR.INFO, fields),
    sendTelegramAlert(`<b>ℹ️ ${title}</b>\n${message}`),
  ]);
}

export async function sendDailyReport(report: DailyReportData): Promise<void> {
  const pnl    = report.endEquity - report.startEquity;
  const pnlPct = ((pnl / report.startEquity) * 100).toFixed(2);
  const sign   = pnl >= 0 ? '+' : '';
  const color  = pnl >= 0 ? COLOR.SUCCESS : COLOR.CRITICAL;

  const title = `Daily summary — ${sign}${pnlPct}%`;
  const fields: DiscordField[] = [
    { name: 'Start equity',    value: `$${report.startEquity.toFixed(2)}`,  inline: true },
    { name: 'End equity',      value: `$${report.endEquity.toFixed(2)}`,    inline: true },
    { name: 'Net PnL',         value: `${sign}$${pnl.toFixed(2)}`,          inline: true },
    { name: 'Trades',          value: String(report.tradesEntered),          inline: true },
    { name: 'Circuit breaker', value: report.circuitBreakerFired ? 'Triggered' : 'Not triggered', inline: true },
    { name: 'Symbols',         value: report.symbols.join(', ') || '—',     inline: false },
  ];

  const telegramText =
    `<b>${pnl >= 0 ? '✅' : '❌'} Daily summary — ${sign}${pnlPct}%</b>\n` +
    `Equity: $${report.startEquity.toFixed(2)} → $${report.endEquity.toFixed(2)}\n` +
    `Net PnL: ${sign}$${pnl.toFixed(2)}\n` +
    `Trades: ${report.tradesEntered}\n` +
    `Circuit breaker: ${report.circuitBreakerFired ? 'Triggered' : 'Not triggered'}\n` +
    `Symbols: ${report.symbols.join(', ') || '—'}`;

  log.info(`Daily summary: PnL ${sign}${pnlPct}% ($${pnl.toFixed(2)})`);
  await Promise.all([
    sendDiscord(
      title,
      `Session summary for ${new Date().toLocaleDateString('fr-FR')}`,
      color,
      fields,
    ),
    sendTelegramAlert(telegramText),
  ]);
}
