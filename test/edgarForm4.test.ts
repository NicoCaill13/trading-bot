import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEdgarForm4Hit,
  parseEdgarSearchPayload,
} from '../src/edgarForm4';

describe('parseEdgarForm4Hit', () => {
  it('accepts a Form 4 search hit', () => {
    const parsed = parseEdgarForm4Hit({
      _source: {
        adsh: '0002016181-26-000005',
        file_date: '2026-08-18',
        form: '4',
        display_names: [
          'Trump Donald J. JR  (CIK 0002016181)',
          'PSQ Holdings, Inc.  (CIK 0001847064)',
        ],
        ciks: ['0002016181', '0001847064'],
      },
    });
    assert.ok(parsed);
    assert.equal(parsed.accessionNumber, '0002016181-26-000005');
    assert.ok(parsed.url.includes('000201618126000005'));
  });

  it('rejects non-Form-4 rows and garbage', () => {
    assert.equal(parseEdgarForm4Hit({ _source: { adsh: '1', file_date: '2026-01-01', form: '8-K' } }), null);
    assert.equal(parseEdgarForm4Hit({ _source: { form: '4' } }), null);
    assert.equal(parseEdgarForm4Hit(null), null);
  });
});

describe('parseEdgarSearchPayload', () => {
  it('dedups by accession number', () => {
    const filings = parseEdgarSearchPayload({
      hits: {
        hits: [
          { _source: { adsh: 'A-1', file_date: '2026-08-18', form: '4', ciks: ['0002016181'] } },
          { _source: { adsh: 'A-1', file_date: '2026-08-18', form: '4', ciks: ['0002016181'] } },
          { _source: { adsh: 'A-2', file_date: '2026-08-19', form: '4', ciks: ['0002016181'] } },
        ],
      },
    });
    assert.equal(filings.length, 2);
    assert.deepEqual(filings.map(f => f.accessionNumber), ['A-1', 'A-2']);
  });
});
