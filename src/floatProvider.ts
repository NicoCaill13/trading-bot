import config from './config';

/**
 * External float data port. Alpaca assets do not expose reliable free-float;
 * wire Polygon / FMP / IEX Cloud behind this interface when enabling the gate.
 */
export interface FloatProvider {
  getFloatShares(symbol: string): Promise<number | null>;
}

/** No-op provider used when FLOAT_FILTER_ENABLED is false (or no vendor wired). */
export class DisabledFloatProvider implements FloatProvider {
  async getFloatShares(_symbol: string): Promise<number | null> {
    return null;
  }
}

export function createFloatProvider(): FloatProvider {
  // Real vendor adapters land here when FLOAT_FILTER_ENABLED=true and credentials exist.
  // Until then, always return the disabled provider (gate skipped or rejects as unavailable).
  return new DisabledFloatProvider();
}

export function isFloatFilterActive(): boolean {
  return config.screener.floatFilterEnabled;
}
