import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clampQueryEnd, isSipStreamDenied } from '../src/utils';

const DELAY_MS = 16 * 60_000;
const now = new Date('2026-08-21T13:20:00.000Z');

describe('clampQueryEnd', () => {
  it('leaves iex windows untouched — no delay entitlement applies', () => {
    const end = new Date('2026-08-21T13:19:00.000Z');
    assert.equal(clampQueryEnd(end, 'iex', DELAY_MS, now).toISOString(), end.toISOString());
  });

  it('pulls a sip window back out of the delay period', () => {
    const end = new Date('2026-08-21T13:19:00.000Z');
    const clamped = clampQueryEnd(end, 'sip', DELAY_MS, now);
    assert.equal(clamped.toISOString(), '2026-08-21T13:04:00.000Z');
  });

  it('leaves a sip window already outside the delay period alone', () => {
    const end = new Date('2026-08-21T12:00:00.000Z');
    assert.equal(clampQueryEnd(end, 'sip', DELAY_MS, now).toISOString(), end.toISOString());
  });

  it('is a no-op exactly at the delay boundary', () => {
    const end = new Date(now.getTime() - DELAY_MS);
    assert.equal(clampQueryEnd(end, 'sip', DELAY_MS, now).toISOString(), end.toISOString());
  });
});

describe('isSipStreamDenied', () => {
  it('treats Alpaca 409 as a licensing refusal', () => {
    assert.equal(isSipStreamDenied(409, 'any'), true);
  });

  it('matches the documented insufficient-subscription message', () => {
    assert.equal(isSipStreamDenied(403, 'insufficient subscription'), true);
    assert.equal(
      isSipStreamDenied(422, 'subscription does not permit querying recent SIP data'),
      true,
    );
  });

  it('does not treat credential failures as a feed fallback', () => {
    assert.equal(isSipStreamDenied(401, 'auth failed'), false);
    assert.equal(isSipStreamDenied(402, 'authentication failed'), false);
  });
});
