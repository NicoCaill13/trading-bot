import fs from 'fs';
import path from 'path';
import type { Logger } from './types';

const LOG_DIR = path.resolve('./logs');

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getTodayFilename(): string {
  const d = new Date().toISOString().split('T')[0];
  return path.join(LOG_DIR, `trading-${d}.log`);
}

function formatLine(level: string, moduleName: string, message: string): string {
  const ts = new Date().toISOString();
  return `${ts} [${level.padEnd(5)}] [${moduleName}] ${message}`;
}

function writeLine(line: string): void {
  try {
    fs.appendFileSync(getTodayFilename(), line + '\n', 'utf8');
  } catch {
    // Never crash the bot on a logging issue
  }
}

export function createLogger(moduleName: string): Logger {
  return {
    info(message: string): void {
      const line = formatLine('INFO', moduleName, message);
      console.log(line);
      writeLine(line);
    },
    warn(message: string): void {
      const line = formatLine('WARN', moduleName, message);
      console.warn(line);
      writeLine(line);
    },
    error(message: string): void {
      const line = formatLine('ERROR', moduleName, message);
      console.error(line);
      writeLine(line);
    },
  };
}
