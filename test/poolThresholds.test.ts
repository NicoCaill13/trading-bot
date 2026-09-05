import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSipPoolThresholds,
  retiredPoolEnvKeysPresent,
  SIP_POOL_MIN_DOLLAR_VOLUME,
  SIP_POOL_MIN_SIZE,
} from '../src/poolThresholds';

describe('assertSipPoolThresholds', () => {
  it('accepts the calibrated SIP floor and cap', () => {
    assert.doesNotThrow(() => assertSipPoolThresholds(5_000_000, 4000));
  });

  it('rejects the IEX-era $1.5M floor', () => {
    assert.throws(
      () => assertSipPoolThresholds(1_500_000, 4000),
      /POOL_SIP_MIN_DOLLAR_VOLUME/,
    );
  });

  it('rejects a 1500 cap that would keep the thinnest names', () => {
    assert.throws(
      () => assertSipPoolThresholds(5_000_000, 1500),
      /POOL_SIP_MAX_SIZE/,
    );
  });

  it('accepts the minimum safe size', () => {
    assert.doesNotThrow(() =>
      assertSipPoolThresholds(SIP_POOL_MIN_DOLLAR_VOLUME, SIP_POOL_MIN_SIZE),
    );
  });
});

describe('retiredPoolEnvKeysPresent', () => {
  it('flags the IEX-era keys that must not drive the SIP pool', () => {
    const found = retiredPoolEnvKeysPresent({
      POOL_MIN_PREV_DOLLAR_VOLUME: '1500000',
      POOL_MAX_SIZE: '1500',
      VWAP_PULLBACK_ENABLED: 'false',
    });
    assert.deepEqual(found, [
      'POOL_MIN_PREV_DOLLAR_VOLUME',
      'POOL_MAX_SIZE',
      'VWAP_PULLBACK_ENABLED',
    ]);
  });

  it('is empty when only the SIP keys are set', () => {
    assert.deepEqual(
      retiredPoolEnvKeysPresent({
        POOL_SIP_MIN_DOLLAR_VOLUME: '5000000',
        POOL_SIP_MAX_SIZE: '4000',
        VWAP_CORE_ENABLED: 'true',
      }),
      [],
    );
  });
});
