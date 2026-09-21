import {
  ZOHO_MODULES, ZOHO_REPORTS, getModule, extractRecord, extractLines, listRows, hasMorePages, detailRecord,
  dateOnly, num, str, parseZohoTimestamp, formatZohoModifiedTime, detailDefault,
} from '@/lib/services/zoho/modules';

const ctx = { baseCurrency: 'INR' };
const mod = (k: string) => getModule(k)!;

describe('module registry', () => {
  test('every module has a unique key, a path and an id field', () => {
    const keys = ZOHO_MODULES.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const m of ZOHO_MODULES) {
      expect(m.path.startsWith('/')).toBe(true);
      expect(m.fields.id).toMatch(/_id$/);
      if (m.detail !== 'none') expect(m.detailKey).toBeTruthy();
    }
  });

  test('expense line detail is opt-in; everything else with detail is on by default', () => {
    expect(detailDefault(mod('expenses'))).toBe(false);
    expect(detailDefault(mod('bills'))).toBe(true);
    expect(detailDefault(mod('journals'))).toBe(true);
  });
});

describe('Phase B modules', () => {
  test('bank transactions are read per bank account, and bank accounts come first in the registry', () => {
    const tx = mod('banktransactions');
    expect(tx.fanOut).toEqual({ parentModule: 'bankaccounts', param: 'account_id' });
    expect(ZOHO_MODULES.findIndex((m) => m.key === 'bankaccounts')).toBeLessThan(ZOHO_MODULES.findIndex((m) => m.key === 'banktransactions'));
  });

  test('every fan-out parent is itself a module', () => {
    for (const m of ZOHO_MODULES) if (m.fanOut) expect(getModule(m.fanOut.parentModule)).toBeDefined();
  });

  test('modules without a modified-time filter are marked as read in full', () => {
    for (const k of ['banktransactions', 'bankaccounts', 'items', 'chartofaccounts', 'fixedassets']) expect(mod(k).incremental).toBe(false);
    for (const k of ['invoices', 'bills', 'journals', 'expenses']) expect(mod(k).incremental).toBe(true);
  });

  test('a bank transaction keeps its bank account as parent, the payee as contact, and the unsigned amount', () => {
    const r = extractRecord(mod('banktransactions'), {
      transaction_id: 't1', account_id: 'a1', account_name: 'HDFC Current', date: '2026-08-31', amount: 1500.5, debit_or_credit: 'debit',
      payee: 'Some Vendor', status: 'categorized', reference_number: 'UTR1', currency_code: 'INR',
    }, ctx)!;
    expect(r).toMatchObject({ zohoId: 'a1:t1', parentId: 'a1', title: 'HDFC Current', docDate: '2026-08-31', amount: 1500.5, contactName: 'Some Vendor', status: 'categorized', docNumber: 'UTR1', baseAmount: 1500.5 });
  });

  test('the same bank transaction id under two bank accounts is two records (a transfer shows on both sides)', () => {
    const row = { transaction_id: 'T1', account_id: 'a1', amount: 10, date: '2026-08-01' };
    const a = extractRecord(mod('banktransactions'), row, ctx, null, 'a1')!;
    const b = extractRecord(mod('banktransactions'), { ...row, account_id: 'a2' }, ctx, null, 'a2')!;
    expect(a.zohoId).toBe('a1:T1');
    expect(b.zohoId).toBe('a2:T1');
    expect(a.zohoId).not.toBe(b.zohoId);
    expect([a.parentId, b.parentId]).toEqual(['a1', 'a2']);
  });

  test('the account a page was listed for wins over what the row itself says', () => {
    const r = extractRecord(mod('banktransactions'), { transaction_id: 'T1', account_id: 'other' }, ctx, null, 'queried')!;
    expect(r).toMatchObject({ zohoId: 'queried:T1', parentId: 'queried' });
  });

  test('a fan-out row with no parent at all cannot be stored', () => {
    expect(extractRecord(mod('banktransactions'), { transaction_id: 'T1' }, ctx)).toBeNull();
  });

  test('ordinary modules keep the plain id', () => {
    expect(extractRecord(mod('bills'), { bill_id: 'B1' }, ctx, null, 'ignored')!.zohoId).toBe('B1');
  });

  test('a bank account: book balance is the amount, bank balance the balance, Zoho\'s bcy_balance the base amount', () => {
    const r = extractRecord(mod('bankaccounts'), { account_id: 'a1', account_name: 'HDFC Current', account_code: '1010', is_active: true, balance: 100, bank_balance: 90, bcy_balance: 100, currency_code: 'INR' }, ctx)!;
    expect(r).toMatchObject({ title: 'HDFC Current', docNumber: '1010', status: 'active', amount: 100, balance: 90, baseAmount: 100 });
  });

  test('an inactive master reads as "inactive", not the word "false"', () => {
    expect(extractRecord(mod('locations'), { location_id: 'l1', location_name: 'Head Office', is_location_active: false }, ctx)!.status).toBe('inactive');
    expect(extractRecord(mod('chartofaccounts'), { account_id: 'x', account_name: 'Sales', account_code: '4000', is_active: true, parent_account_id: 'p' }, ctx)).toMatchObject({ status: 'active', parentId: 'p', title: 'Sales' });
  });

  test('documents have no title', () => {
    expect(extractRecord(mod('bills'), { bill_id: 'b1', total: 1 }, ctx)!.title).toBeNull();
  });

  test('report definitions cover the GST tax summary and both ageing reports, and leave out the unreliable trial balance', () => {
    const keys = ZOHO_REPORTS.map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining(['taxsummary', 'aragingsummary', 'apagingsummary']));
    expect(keys).not.toContain('trialbalance');
    expect(ZOHO_REPORTS.find((r) => r.key === 'aragingsummary')!.period).toBe('asof');
  });
});

describe('value helpers', () => {
  test('dateOnly accepts real dates only', () => {
    expect(dateOnly('2026-03-31')).toBe('2026-03-31');
    expect(dateOnly('2026-03-31T10:00:00+0530')).toBe('2026-03-31');
    expect(dateOnly('2026-02-30')).toBeNull();
    expect(dateOnly('31/03/2026')).toBeNull();
    expect(dateOnly('')).toBeNull();
  });

  test('num / str tolerate strings, blanks and junk', () => {
    expect(num('1234.5')).toBe(1234.5);
    expect(num('')).toBeNull();
    expect(num('abc')).toBeNull();
    expect(num(0)).toBe(0);
    expect(str('  x ')).toBe('x');
    expect(str('   ')).toBeNull();
  });

  test('Zoho timestamps with a +0530 offset parse to the right UTC instant', () => {
    expect(parseZohoTimestamp('2026-09-01T10:15:30+0530')).toBe('2026-09-01T04:45:30.000Z');
    expect(parseZohoTimestamp('2026-09-01T10:15:30+05:30')).toBe('2026-09-01T04:45:30.000Z');
    expect(parseZohoTimestamp('2026-09-01T10:15:30Z')).toBe('2026-09-01T10:15:30.000Z');
    expect(parseZohoTimestamp('garbage')).toBeNull();
  });

  test('the modified-time filter is written in the format Zoho accepts', () => {
    expect(formatZohoModifiedTime(new Date('2026-09-20T00:00:00.000Z'))).toBe('2026-09-20T00:00:00+0000');
    expect(formatZohoModifiedTime('2026-09-20T05:30:12.999Z')).toBe('2026-09-20T05:30:12+0000');
  });
});

describe('extractRecord', () => {
  test('an invoice in the base currency: base_amount is the document amount', () => {
    const r = extractRecord(mod('invoices'), {
      invoice_id: 'i1', invoice_number: 'INV-1', date: '2026-04-05', due_date: '2026-05-05', status: 'paid',
      customer_id: 'c1', customer_name: 'Acme', total: 1180, balance: 0, currency_code: 'inr', exchange_rate: 1,
      last_modified_time: '2026-04-06T10:00:00+0530',
    }, ctx)!;
    expect(r).toMatchObject({
      zohoId: 'i1', docNumber: 'INV-1', docDate: '2026-04-05', dueDate: '2026-05-05', status: 'paid', contactId: 'c1',
      currencyCode: 'INR', amount: 1180, baseAmount: 1180, balance: 0, modifiedAt: '2026-04-06T04:30:00.000Z',
    });
  });

  test('a foreign-currency bill with no base figure keeps base_amount empty: the rate is never guessed', () => {
    const r = extractRecord(mod('bills'), { bill_id: 'b1', bill_number: 'B-9', date: '2026-05-01', vendor_id: 'v1', vendor_name: 'Foreign Co', currency_code: 'USD', exchange_rate: 84.2, total: 100 }, ctx)!;
    expect(r.amount).toBe(100);
    expect(r.exchangeRate).toBe(84.2);
    expect(r.baseAmount).toBeNull();
  });

  test('a foreign-currency invoice uses Zoho\'s own bcy_total from the detail record', () => {
    const r = extractRecord(mod('invoices'), { invoice_id: 'i2', date: '2026-05-01', total: 100, currency_code: 'USD', exchange_rate: 84.2 }, ctx, { invoice_id: 'i2', bcy_total: 8420 })!;
    expect(r.baseAmount).toBe(8420);
  });

  test('a row without an id cannot be stored', () => {
    expect(extractRecord(mod('bills'), { bill_number: 'x' }, ctx)).toBeNull();
  });

  test('expense tax is total minus total-without-tax when Zoho gives no tax figure', () => {
    const r = extractRecord(mod('expenses'), { expense_id: 'e1', date: '2026-06-01', total: 1180, total_without_tax: 1000, currency_code: 'INR', bcy_total: 1180 }, ctx)!;
    expect(r.subAmount).toBe(1000);
    expect(r.taxAmount).toBe(180);
  });

  test('bills do not get a derived tax (their total also carries TDS and adjustments)', () => {
    const r = extractRecord(mod('bills'), { bill_id: 'b2', total: 1180, currency_code: 'INR' }, ctx)!;
    expect(r.taxAmount).toBeNull();
  });

  test('GST fields come from the detail record when the list row has none', () => {
    const r = extractRecord(mod('invoices'), { invoice_id: 'i3', total: 10 }, ctx, { invoice_id: 'i3', gst_treatment: 'business_gst', gst_no: '29ABCDE1234F1Z5', place_of_supply: 'KA', tax_total: 1.5, sub_total: 8.5 })!;
    expect(r).toMatchObject({ gstTreatment: 'business_gst', gstNo: '29ABCDE1234F1Z5', placeOfSupply: 'KA', taxAmount: 1.5, subAmount: 8.5 });
  });

  test('a bill takes its place of supply from source_of_supply', () => {
    const r = extractRecord(mod('bills'), { bill_id: 'b3', source_of_supply: 'MH', gst_treatment: 'business_gst', gst_no: '27AAAAA0000A1Z5' }, ctx)!;
    expect(r.placeOfSupply).toBe('MH');
  });

  test('journals: number, date and Zoho\'s base total', () => {
    const r = extractRecord(mod('journals'), { journal_id: 'j1', entry_number: '12', journal_date: '2026-07-02', total: 500, bcy_total: 500, status: 'published' }, ctx)!;
    expect(r).toMatchObject({ zohoId: 'j1', docNumber: '12', docDate: '2026-07-02', amount: 500, baseAmount: 500 });
  });

  test('customer payments: unused amount is the balance, base from bcy_amount', () => {
    const r = extractRecord(mod('customerpayments'), { payment_id: 'p1', payment_number: '7', date: '2026-08-31', amount: 100, unused_amount: 20, bcy_amount: 8420, customer_id: 'c1' }, ctx)!;
    expect(r).toMatchObject({ amount: 100, balance: 20, baseAmount: 8420, contactId: 'c1' });
  });
});

describe('extractLines', () => {
  test('item lines carry HSN, ITC and tax summed from line_item_taxes', () => {
    const lines = extractLines(mod('bills'), {
      line_items: [{
        line_item_id: 'l1', account_id: 'a1', account_name: 'Office Rent', description: 'Rent', item_id: 'it1', name: 'Rent', quantity: 1, rate: 1000, item_total: 1000,
        tax_id: 't1', tax_name: 'GST18', tax_percentage: 18, hsn_or_sac: '997212', itc_eligibility: 'eligible', gst_treatment_code: 'x',
        line_item_taxes: [{ tax_id: 'c', tax_name: 'CGST9', tax_amount: 90 }, { tax_id: 's', tax_name: 'SGST9', tax_amount: 90 }],
      }],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      lineNo: 1, kind: 'item', accountId: 'a1', accountName: 'Office Rent', itemName: 'Rent', quantity: 1, rate: 1000, amount: 1000,
      taxName: 'GST18', taxPercentage: 18, taxAmount: 180, hsnOrSac: '997212', itcEligibility: 'eligible',
    });
    expect(lines[0]!.taxes).toHaveLength(2);
  });

  test('a line with no line_item_taxes falls back to its own tax_amount (expense lines)', () => {
    const lines = extractLines(mod('expenses'), { line_items: [{ account_name: 'Travel', item_total: 500, tax_amount: 25, tax_name: 'GST5' }] });
    expect(lines[0]).toMatchObject({ accountName: 'Travel', amount: 500, taxAmount: 25, taxes: null });
  });

  test('journal legs keep debit / credit, base amount and the amounts stay positive', () => {
    const lines = extractLines(mod('journals'), {
      line_items: [
        { line_id: '1', account_id: 'a1', account_name: 'Bank', debit_or_credit: 'debit', amount: 100, bcy_amount: 100 },
        { line_id: '2', account_id: 'a2', account_name: 'Sales', debit_or_credit: 'credit', amount: 100, bcy_amount: 100, customer_id: 'c1', customer_name: 'Acme' },
      ],
    });
    expect(lines.map((l) => [l.lineNo, l.debitOrCredit, l.amount, l.baseAmount])).toEqual([[1, 'debit', 100, 100], [2, 'credit', 100, 100]]);
    expect(lines[1]).toMatchObject({ refId: 'c1', refNumber: 'Acme' });
  });

  test('a customer payment lists the invoices it was applied to', () => {
    const lines = extractLines(mod('customerpayments'), { invoices: [{ invoice_id: 'i1', invoice_number: 'INV-1', amount_applied: 60 }, { invoice_id: 'i2', invoice_number: 'INV-2', amount_applied: 40 }] });
    expect(lines.map((l) => [l.kind, l.refId, l.refNumber, l.amount])).toEqual([['applied', 'i1', 'INV-1', 60], ['applied', 'i2', 'INV-2', 40]]);
  });

  test('a credit note has its items and the invoices it credited, numbered in sequence', () => {
    const lines = extractLines(mod('creditnotes'), {
      line_items: [{ name: 'Refund', item_total: 50 }],
      invoices_credited: [{ invoice_id: 'i1', invoice_number: 'INV-1', credited_amount: 50 }],
    });
    expect(lines.map((l) => [l.lineNo, l.kind, l.amount])).toEqual([[1, 'item', 50], [2, 'applied', 50]]);
  });

  test('no detail, or no lines, gives no rows', () => {
    expect(extractLines(mod('bills'), null)).toEqual([]);
    expect(extractLines(mod('bills'), {})).toEqual([]);
    expect(extractLines(mod('bills'), { line_items: 'x' })).toEqual([]);
  });
});

describe('reading a response', () => {
  test('listRows uses the module key, else the first array Zoho sent', () => {
    expect(listRows(mod('bills'), { bills: [{ bill_id: '1' }], page_context: {} })).toHaveLength(1);
    expect(listRows(mod('vendorcredits'), { page_context: {}, credits: [{ vendor_credit_id: '9' }] })).toEqual([{ vendor_credit_id: '9' }]);
    expect(listRows(mod('bills'), null)).toEqual([]);
    expect(listRows(mod('bills'), { code: 0, message: 'success' })).toEqual([]);
  });

  test('hasMorePages reads page_context.has_more_page', () => {
    expect(hasMorePages({ page_context: { has_more_page: true } })).toBe(true);
    expect(hasMorePages({ page_context: { has_more_page: false } })).toBe(false);
    expect(hasMorePages({})).toBe(false);
  });

  test('detailRecord finds the record under the module\'s key, else the first object', () => {
    expect(detailRecord(mod('bills'), { code: 0, bill: { bill_id: '1' } })).toEqual({ bill_id: '1' });
    expect(detailRecord(mod('vendorpayments'), { code: 0, payment: { payment_id: '2' } })).toEqual({ payment_id: '2' });
    expect(detailRecord(mod('bills'), { code: 0, message: 'ok' })).toBeNull();
  });
});
