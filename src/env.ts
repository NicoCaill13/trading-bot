import dotenv from 'dotenv';

/**
 * Environment loading and parsing primitives.
 *
 * Extracted from `config.ts` so that dependency-free processes (the standalone
 * watchdog) can read their own settings without importing the trading config —
 * whose validation IIFE throws when any trading variable is missing.
 *
 * Loading happens here rather than in each entry point for two reasons: it keeps
 * a single decision point for which file wins, and it removes a CommonJS
 * ordering trap — a `dotenv.config()` written between imports in a consumer is
 * emitted *after* that consumer's `require` calls.
 *
 * ENV_FILE lets the test suite load a frozen fixture instead of the developer's
 * .env, so assertions verify code defaults rather than local overrides.
 */
dotenv.config({ path: process.env.ENV_FILE ?? '.env' });

export function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`[SYSTEM] Missing environment variable: ${key}`);
  }
  return value;
}

export function parseFloatEnv(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = parseFloat(raw);
  if (isNaN(parsed)) throw new Error(`[SYSTEM] Invalid float for ${key}: "${raw}"`);
  return parsed;
}

export function parseIntEnv(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) throw new Error(`[SYSTEM] Invalid integer for ${key}: "${raw}"`);
  return parsed;
}

export function parseStringEnv(key: string, defaultValue: string): string {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  return raw.trim();
}

export function optionalEnv(key: string): string | null {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return null;
  return raw.trim();
}
