import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFederalRegisterDocument,
  parseFederalRegisterPayload,
} from '../src/federalRegister';

describe('parseFederalRegisterDocument', () => {
  it('accepts a well-formed presidential document', () => {
    const parsed = parseFederalRegisterDocument({
      document_number: '2026-14454',
      title: 'Adjusting Imports of Aluminum into the United States',
      abstract: 'Section 232 adjustment.',
      html_url: 'https://www.federalregister.gov/d/2026-14454',
      publication_date: '2026-08-06',
      presidential_document_type: 'proclamation',
    });
    assert.ok(parsed);
    assert.equal(parsed.documentNumber, '2026-14454');
    assert.equal(parsed.subtype, 'proclamation');
  });

  it('rejects rows without a document number or title', () => {
    assert.equal(parseFederalRegisterDocument({ title: 'x' }), null);
    assert.equal(parseFederalRegisterDocument({ document_number: '1' }), null);
    assert.equal(parseFederalRegisterDocument(null), null);
  });
});

describe('parseFederalRegisterPayload', () => {
  it('skips malformed rows and keeps valid ones', () => {
    const docs = parseFederalRegisterPayload({
      count: 2,
      results: [
        { document_number: '1', title: 'Tariff proclamation' },
        { foo: 'bar' },
      ],
    });
    assert.equal(docs.length, 1);
    assert.equal(docs[0]?.documentNumber, '1');
  });

  it('returns an empty list on garbage', () => {
    assert.deepEqual(parseFederalRegisterPayload(null), []);
    assert.deepEqual(parseFederalRegisterPayload({ results: 'nope' }), []);
  });
});
