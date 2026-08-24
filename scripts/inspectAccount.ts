/**
 * Diagnostic: dumps the Alpaca account payload so account type, multiplier and
 * buying-power semantics can be checked against what the sizing path reads.
 * Identifiers are redacted — this is safe to paste into an issue.
 *
 * Run: npx tsx scripts/inspectAccount.ts
 */

import config from '../src/config';

const REDACTED_KEYS = new Set(['id', 'account_number']);

async function main(): Promise<void> {
  const res = await fetch(`${config.alpaca.baseUrl}/v2/account`, {
    headers: {
      'APCA-API-KEY-ID': config.alpaca.keyId,
      'APCA-API-SECRET-KEY': config.alpaca.secretKey,
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  const account = (await res.json()) as Record<string, unknown>;

  const entries = Object.entries(account)
    .filter(([, value]) => value !== null && value !== '')
    .map(([key, value]): [string, unknown] =>
      REDACTED_KEYS.has(key) ? [key, '<redacted>'] : [key, value],
    )
    .sort(([a], [b]) => a.localeCompare(b));

  for (const [key, value] of entries) {
    console.log(`${key.padEnd(34)} ${String(value)}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
