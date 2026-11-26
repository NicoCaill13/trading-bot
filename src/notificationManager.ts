import config from './config';
import { createLogger } from './logger';
import { sendTelegramMessage } from './telegramClient';

const log = createLogger('NOTIFICATION');

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
