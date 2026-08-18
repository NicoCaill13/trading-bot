import { toErrorMessage } from './utils';

/**
 * Telegram transport, deliberately unaware of `config`.
 *
 * The watchdog must be able to alert even when the trading configuration fails
 * to validate, so credentials are injected rather than imported. Delivery
 * outcome is returned instead of logged: the caller owns its own log prefix.
 */

const TELEGRAM_TIMEOUT_MS = 8000;

export interface TelegramCredentials {
  token: string | null;
  chatId: string | null;
}

export type TelegramSendResult =
  | { delivered: true }
  | { delivered: false; reason: string };

export async function sendTelegramMessage(
  credentials: TelegramCredentials,
  message: string,
): Promise<TelegramSendResult> {
  const { token, chatId } = credentials;
  if (!token || !chatId) {
    return { delivered: false, reason: 'Telegram credentials not configured' };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return { delivered: false, reason: `Telegram API HTTP ${response.status}` };
    }
    return { delivered: true };
  } catch (err) {
    return { delivered: false, reason: toErrorMessage(err) };
  } finally {
    clearTimeout(timeoutId);
  }
}
