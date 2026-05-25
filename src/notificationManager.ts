import config from './config';
import { createLogger } from './logger';
import { toErrorMessage } from './utils';
import type { SignalTier, Watchlist } from './types';

const log = createLogger('NOTIFICATION');

const TELEGRAM_TIMEOUT_MS = 8000;

/**
 * Sends an HTML-formatted alert via the Telegram Bot API.
 * Failures are logged and swallowed — never throws, never blocks trading.
 */
export async function sendTelegramAlert(message: string): Promise<void> {
  const token = config.notify.telegramBotToken;
  const chatId = config.notify.telegramChatId;
  if (!token || !chatId) return;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      log.warn(`Telegram API HTTP ${response.status}`);
    }
  } catch (err) {
    log.warn(`Telegram alert failed: ${toErrorMessage(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Message formatters (V4 spec)
// ---------------------------------------------------------------------------

export function formatStartupAlert(
  baseline: number,
  coreSlots: number,
  satelliteSlots: number,
): string {
  return (
    `🟢 <b>[SYSTEM]</b> Bot V4 Démarré | ` +
    `Baseline: $${baseline.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} | ` +
    `Slots: ${coreSlots} Core / ${satelliteSlots} Satellite`
  );
}

export function formatEntryAlert(
  qty: number,
  symbol: string,
  tier: SignalTier,
  price: number,
  stopLoss: number,
): string {
  const typeLabel = tier === 'satellite' ? 'Satellite' : 'Core';
  return (
    `🚀 <b>[ENTRY]</b> Achat ${qty}x ${symbol} (${typeLabel}) ` +
    `à $${price.toFixed(2)} | Stop Loss: $${stopLoss.toFixed(2)}`
  );
}

export function formatTakeProfitAlert(symbol: string): string {
  return (
    `💰 <b>[TAKE PROFIT]</b> Cible atteinte sur ${symbol} ! ` +
    `Vente de 50%. Stop Loss remonté au Break-Even.`
  );
}

export function formatExitAlert(symbol: string, reason: string): string {
  return `🛑 <b>[EXIT]</b> Position liquidée sur ${symbol} | Raison : ${reason}`;
}

export function formatErrorAlert(message: string): string {
  return `⚠️ <b>[ERROR]</b> ${message}`;
}

export function formatWatchlistAlert(watchlist: Watchlist): string {
  const coreTickers: string[] = [];
  const satelliteTickers: string[] = [];

  for (const entry of watchlist.symbols) {
    if (entry.origin === 'V2_PLAYMAKER') {
      satelliteTickers.push(entry.symbol);
    } else {
      coreTickers.push(entry.symbol);
    }
  }

  const coreLine = coreTickers.length > 0 ? coreTickers.join(', ') : '—';
  const satLine = satelliteTickers.length > 0 ? satelliteTickers.join(', ') : '—';

  return (
    `📋 <b>[WATCHLIST DU JOUR]</b>\n` +
    `🎯 <b>CORE (V1) :</b> ${coreLine}\n` +
    `🚀 <b>SATELLITES (V2) :</b> ${satLine}`
  );
}

export function humanizeExitReason(reason: string): string {
  const labels: Record<string, string> = {
    'eod-liquidation': 'EOD Sweep (sous VWAP / perte)',
    'eod-no-session-data': 'EOD Sweep (données session manquantes)',
    'hard-close-15h58': 'Hard Close 15h58',
    'circuit-breaker-daily-target': 'Circuit Breaker (+1% PnL)',
    'daily-drawdown-kill': 'Daily Kill-Switch (-1.5% PnL)',
    'RSI_OVERBOUGHT_EXIT': 'Smart Exit RSI (surachat)',
    'VOLUME_EXHAUSTION_TRAILING': 'Smart Exit Volume Exhaustion',
  };
  return labels[reason] ?? reason;
}

export async function notifyWatchlistSaved(watchlist: Watchlist): Promise<void> {
  await sendTelegramAlert(formatWatchlistAlert(watchlist));
}
