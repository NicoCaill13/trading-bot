import config from './config';
import { createLogger } from './logger';
import { sendTelegramMessage } from './telegramClient';
import type { SetupKind, Watchlist } from './types';

const log = createLogger('NOTIFICATION');

/**
 * Sends an HTML-formatted alert via the Telegram Bot API.
 * Failures are logged and swallowed — never throws, never blocks trading.
 */
export async function sendTelegramAlert(message: string): Promise<void> {
  const result = await sendTelegramMessage(
    {
      token: config.notify.telegramBotToken,
      chatId: config.notify.telegramChatId,
    },
    message,
  );

  if (!result.delivered && config.notify.telegramBotToken !== null) {
    log.warn(`Telegram alert failed: ${result.reason}`);
  }
}

// ---------------------------------------------------------------------------
// Message formatters (V4 spec)
// ---------------------------------------------------------------------------

export function formatStartupAlert(
  baseline: number,
  maxPositions: number,
): string {
  return (
    `🟢 <b>[SYSTEM]</b> Bot V4 Démarré | ` +
    `Baseline: $${baseline.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} | ` +
    `Slots: ${maxPositions} (pool unique)`
  );
}

export function formatEntryAlert(
  qty: number,
  symbol: string,
  setup: SetupKind,
  price: number,
  stopLoss: number,
): string {
  return (
    `🚀 <b>[ENTRY]</b> Achat ${qty}x ${symbol} [${setup}] ` +
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
  const v1Tickers: string[] = [];
  const v2Tickers: string[] = [];

  for (const entry of watchlist.symbols) {
    if (entry.origin === 'V2_PLAYMAKER') {
      v2Tickers.push(entry.symbol);
    } else {
      v1Tickers.push(entry.symbol);
    }
  }

  const v1Line = v1Tickers.length > 0 ? v1Tickers.join(', ') : '—';
  const v2Line = v2Tickers.length > 0 ? v2Tickers.join(', ') : '—';

  return (
    `📋 <b>[WATCHLIST DU JOUR]</b>\n` +
    `🎯 <b>V1_CORE :</b> ${v1Line}\n` +
    `🚀 <b>V2_PLAYMAKER :</b> ${v2Line}`
  );
}

export function humanizeExitReason(reason: string): string {
  const labels: Record<string, string> = {
    'eod-liquidation': 'EOD Sweep (sous VWAP / perte)',
    'eod-no-session-data': 'EOD Sweep (données session manquantes)',
    'hard-close-15h55': 'Hard Close 15h55',
    'hard-close-15h58': 'Hard Close 15h58',
    'time-stop': 'Time-Stop (stagnation 45m)',
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
