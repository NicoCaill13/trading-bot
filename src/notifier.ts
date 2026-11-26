import https from 'https';
import { URL } from 'url';
import { createLogger } from './logger';
import { sendTelegramAlert } from './notificationManager';
import type { DiscordField } from './types';

const log = createLogger('NOTIFIER');

const COLOR = {
  SUCCESS: 0x2ECC71,
  CRITICAL: 0xE74C3C,
  INFO: 0x3498DB,
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

function postJson(urlStr: string, payload: { embeds: DiscordEmbed[] }): Promise<void> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(urlStr);
    } catch {
      log.warn(`Invalid webhook URL: ${urlStr}`);
      return resolve();
    }

    const body = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 8000,
      },
      (res) => {
        res.resume();
        if (res.statusCode !== undefined && res.statusCode >= 400) {
          log.warn(`Webhook HTTP ${res.statusCode} for ${parsed.hostname}`);
        }
        resolve();
      },
    );

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

async function sendDiscord(
  title: string,
  description: string,
  color: ColorValue,
  fields: DiscordField[] = [],
): Promise<void> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  await postJson(url, {
    embeds: [{
      title,
      description,
      color,
      fields,
      timestamp: new Date().toISOString(),
      footer: { text: 'Swing study radar — read only' },
    }],
  });
}

export async function alertInfo(
  title: string,
  message: string,
  fields: DiscordField[] = [],
): Promise<void> {
  log.info(`[NOTIFICATION] ${title} — ${message}`);
  await Promise.all([
    sendDiscord(title, message, COLOR.INFO, fields),
    sendTelegramAlert(`<b>${title}</b>\n${message}`),
  ]);
}

export async function alertCritical(
  title: string,
  message: string,
  fields: DiscordField[] = [],
): Promise<void> {
  log.error(`[CRITICAL ALERT] ${title} — ${message}`);
  await Promise.all([
    sendDiscord(title, message, COLOR.CRITICAL, fields),
    sendTelegramAlert(`<b>CRITICAL — ${title}</b>\n${message}`),
  ]);
}
