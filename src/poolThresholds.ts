/**
 * SIP eligible-pool floors. The 09:15 list is an eligibility set, not a
 * liquidity ranking. Overflow drops the most liquid names first — that only
 * works when the cap sits above the SIP pass count (~2000 at $5M).
 *
 * IEX-era keys (POOL_MIN_PREV_DOLLAR_VOLUME=1.5M, POOL_MAX_SIZE=1500) must
 * not be readable: on SIP they keep the thinnest names and drop the runners.
 */

export const SIP_POOL_MIN_DOLLAR_VOLUME = 5_000_000;
export const SIP_POOL_MIN_SIZE = 2500;

export const RETIRED_POOL_ENV_KEYS = [
  'POOL_MIN_PREV_DOLLAR_VOLUME',
  'POOL_MAX_PREV_DOLLAR_VOLUME',
  'POOL_MAX_SIZE',
  'VWAP_PULLBACK_ENABLED',
] as const;

export function retiredPoolEnvKeysPresent(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return RETIRED_POOL_ENV_KEYS.filter(key => env[key] !== undefined);
}

export function assertSipPoolThresholds(minDollarVolume: number, maxSize: number): void {
  if (minDollarVolume < SIP_POOL_MIN_DOLLAR_VOLUME) {
    throw new Error(
      `[SYSTEM] POOL_SIP_MIN_DOLLAR_VOLUME must be >= ${SIP_POOL_MIN_DOLLAR_VOLUME} ` +
      `(SIP scale). ${minDollarVolume} is the IEX-era floor and inverts the pool ` +
      `when overflow drops the most liquid names.`,
    );
  }
  if (maxSize < SIP_POOL_MIN_SIZE) {
    throw new Error(
      `[SYSTEM] POOL_SIP_MAX_SIZE must be >= ${SIP_POOL_MIN_SIZE} ` +
      `(SIP pass count is ~2000). ${maxSize} keeps the thinnest names and ` +
      `drops CRCL/MARA/RIOT.`,
    );
  }
}
