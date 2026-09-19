import { contentHash, hashableFromStoredLedger, hashableFromStoredEntity, type HashableBatch, type HashableLedger } from '@/lib/ingestion/content-hash';

const ledger = (name: string, code: string | null, amounts: number[], over: Partial<HashableLedger> = {}): HashableLedger => ({
  code, name, note_no: 26, note_name: 'Other Expenses', section: 'exp', treasury_type: null, normal_bal: 'Dr',
  amounts: [...amounts, ...Array(26 - amounts.length).fill(0)], ...over,
});
const batch = (over: Partial<HashableBatch> = {}): HashableBatch => ({
  currency: 'INR',
  ledgers: [ledger('Rent', '7041', [0, 0, 300]), ledger('Bank', '2101', [1000, 0])],
  customerRevenue: [{ externalId: 'c1', name: 'Acme', m: [100, ...Array(11).fill(0)] }],
  ...over,
});

describe('contentHash — "would this load change anything?"', () => {
  test('same figures → same fingerprint, whatever the row order', () => {
    const a = batch();
    const b = batch({ ledgers: [...a.ledgers].reverse() });
    expect(contentHash(b)).toBe(contentHash(a));
  });

  test('rounded to paise: float noise does not count as a change', () => {
    expect(contentHash(batch({ ledgers: [ledger('Rent', '7041', [0, 0, 0.1 + 0.2])] })))
      .toBe(contentHash(batch({ ledgers: [ledger('Rent', '7041', [0, 0, 0.3])] })));
  });

  test.each([
    ['one paisa in one month', batch({ ledgers: [ledger('Rent', '7041', [0, 0, 300.01]), ledger('Bank', '2101', [1000, 0])] })],
    ['a mapping change (reclassified)', batch({ ledgers: [ledger('Rent', '7041', [0, 0, 300], { note_no: 22 }), ledger('Bank', '2101', [1000, 0])] })],
    ['a renamed ledger', batch({ ledgers: [ledger('Rent & Rates', '7041', [0, 0, 300]), ledger('Bank', '2101', [1000, 0])] })],
    ['an extra ledger', batch({ ledgers: [...batch().ledgers, ledger('New', '9000', [0, 0])] })],
    ['a customer amount', batch({ customerRevenue: [{ externalId: 'c1', name: 'Acme', m: [101, ...Array(11).fill(0)] }] })],
    ['the currency', batch({ currency: 'USD' })],
  ])('any real change → different fingerprint: %s', (_label, changed) => {
    expect(contentHash(changed)).not.toBe(contentHash(batch()));
  });

  test('a STORED batch (pg NUMERIC strings, m1..m12 columns) fingerprints the same as the incoming rows', () => {
    const stored = {
      ledger_code: '7041', ledger_name: 'Rent', note_no: 26, note_name: 'Other Expenses', section: 'exp', treasury_type: null,
      normal_bal: 'Dr', zoho_account_id: null, zoho_account_type: null, op_dr: '0.00', op_cr: '0.00',
      ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [[`m${i + 1}_dr`, i === 0 ? '300.00' : '0.00'], [`m${i + 1}_cr`, '0.00']]).flat()),
    };
    const storedEntity = { zoho_customer_id: 'c1', customer_name: 'Acme', ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`m${i + 1}`, i === 0 ? '100.00' : '0.00'])) };
    const incoming = batch({ ledgers: [ledger('Rent', '7041', [0, 0, 300])] });
    const fromStore = contentHash({
      currency: 'INR',
      ledgers: [hashableFromStoredLedger(stored)],
      customerRevenue: [hashableFromStoredEntity(storedEntity, 'zoho_customer_id', 'customer_name')],
    });
    expect(fromStore).toBe(contentHash(incoming));
  });
});
