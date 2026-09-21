import {
  getFyMonthIndex, extractSalesByCustomer, aggregateSalesByCustomer, aggregateVendorBills, aggregateCustomerCost,
  fetchAllPages, buildSyncNotes,
} from '@/lib/services/zoho/people';

const report = (rows: Record<string, unknown>[]) => ({ code: 0, message: 'success', sales: rows });
const row = (name: string, sales: number, currency: string, id = name.toLowerCase().replace(/\W/g, '')) =>
  ({ customer_id: id, customer_name: name, currency_code: currency, sales, sales_with_tax: sales, count: 1 });

describe('getFyMonthIndex — which month of the financial year a date falls in', () => {
  test('April is 0 and March of the next calendar year is 11', () => {
    expect(getFyMonthIndex('2025-04-01', '2025-04-01')).toBe(0);
    expect(getFyMonthIndex('2025-12-31', '2025-04-01')).toBe(8);
    expect(getFyMonthIndex('2026-01-01', '2025-04-01')).toBe(9);
    expect(getFyMonthIndex('2026-03-31', '2025-04-01')).toBe(11);
  });
  test('outside the year, missing or unparseable → -1', () => {
    expect(getFyMonthIndex('2025-03-31', '2025-04-01')).toBe(-1);
    expect(getFyMonthIndex('2026-04-01', '2025-04-01')).toBe(-1);
    expect(getFyMonthIndex('', '2025-04-01')).toBe(-1);
    expect(getFyMonthIndex(undefined, '2025-04-01')).toBe(-1);
    expect(getFyMonthIndex('not a date', '2025-04-01')).toBe(-1);
  });
});

describe('Sales by Customer — every customer counts, whatever currency it is invoiced in', () => {
  // Real Variable FY 2025-26: Zoho's own invoices are USD × exchange rate, and the report's figure equals that in rupees.
  test('REGRESSION: a USD customer is included, at Zoho\'s base-currency amount (it used to be skipped, hiding 83% of customer sales)', () => {
    const usdInvoiceInInr = 100000 * 84.2;               // 30 Apr 2025: USD 100,000 at 84.20
    const results = [{
      key: 0, error: null,
      rawResponse: report([row('Overseas Parent Inc', usdInvoiceInInr, 'USD'), row('Domestic Client', 640000, 'INR')]),
    }, {
      key: 2, error: null,
      rawResponse: report([row('Overseas Parent Inc', 50000 * 85.5439, 'USD')]),
    }];
    const agg = aggregateSalesByCustomer(results, 'INR');
    const usd = agg.rows.get('Overseas Parent Inc')!;
    expect(usd.m[0]).toBe(8420000);
    expect(usd.m[2]).toBeCloseTo(4277195, 2);
    expect(agg.rows.get('Domestic Client')!.m[0]).toBe(640000);
    const total = [...agg.rows.values()].reduce((s, r) => s + r.m.reduce((a, b) => a + b, 0), 0);
    expect(usd.m.reduce((a, b) => a + b, 0) / total).toBeGreaterThan(0.9);   // the dominant customer is visible
    expect(agg.otherCurrency).toEqual(['Overseas Parent Inc (USD)']);          // reported as information, not skipped
  });

  test('a credit note (negative sales) is kept as a negative month, not dropped', () => {
    const agg = aggregateSalesByCustomer([{ key: 10, error: null, rawResponse: report([row('Gulf Customer', -1493508.42, 'AED')]) }], 'INR');
    expect(agg.rows.get('Gulf Customer')!.m[10]).toBe(-1493508.42);
  });

  test('months add up per customer, in the right column, and the customer id is kept', () => {
    const agg = aggregateSalesByCustomer([
      { key: 3, error: null, rawResponse: report([row('A', 100, 'INR', 'id-a')]) },
      { key: 3, error: null, rawResponse: report([row('A', 50, 'INR', 'id-a')]) },
      { key: 4, error: null, rawResponse: report([row('A', 7, 'INR', 'id-a')]) },
    ], 'INR');
    const a = agg.rows.get('A')!;
    expect(a.m[3]).toBe(150); expect(a.m[4]).toBe(7); expect(a.m.reduce((x, y) => x + y, 0)).toBe(157);
    expect(a.id).toBe('id-a');
  });

  test('failed monthly reports are counted, and rows without a name are ignored', () => {
    const agg = aggregateSalesByCustomer([
      { key: 0, error: 'Apr: rate limited', rawResponse: null },
      { key: 1, error: null, rawResponse: report([row('   ', 10, 'INR'), row('B', 5, 'INR')]) },
    ], 'INR');
    expect(agg.fetchErrors).toBe(1);
    expect([...agg.rows.keys()]).toEqual(['B']);
  });

  test('the report\'s array may be called something else', () => {
    expect(extractSalesByCustomer({ customers: [{ contact_name: 'X', total: '12.5', currency: 'usd' }] }))
      .toEqual([{ customer_id: undefined, customer_name: 'X', total: 12.5, currency_code: 'USD' }]);
    expect(extractSalesByCustomer(null)).toEqual([]);
    expect(extractSalesByCustomer({ nothing: [] })).toEqual([]);
  });
});

describe('Vendor bills', () => {
  const FY = '2025-04-01';
  const bill = (over: Record<string, unknown>) => ({ vendor_id: 'v1', vendor_name: 'Acme Supplies', currency_code: 'INR', total: 1000, date: '2025-06-15', ...over });

  test('base-currency bills go to the month of their bill date', () => {
    const agg = aggregateVendorBills([bill({}), bill({ total: 500, date: '2025-06-30' }), bill({ total: 7, date: '2026-03-31' })], FY, 'INR');
    const v = agg.rows.get('Acme Supplies')!;
    expect(v.m[2]).toBe(1500); expect(v.m[11]).toBe(7); expect(agg.billsSeen).toBe(3);
  });

  test('a foreign-currency bill is counted through Zoho\'s own base-currency amount when it has one', () => {
    const agg = aggregateVendorBills([bill({ vendor_name: 'Cloud Co', currency_code: 'USD', total: 100, bcy_total: 8420 })], FY, 'INR');
    expect(agg.rows.get('Cloud Co')!.m[2]).toBe(8420);
    expect(agg.convertedForeign).toBe(1); expect(agg.skippedForeign).toBe(0);
  });

  test('without a base-currency amount it is left out and counted — never converted with a guessed rate', () => {
    const agg = aggregateVendorBills([bill({ vendor_name: 'Cloud Co', currency_code: 'USD', total: 100 })], FY, 'INR');
    expect(agg.rows.size).toBe(0);
    expect(agg.skippedForeign).toBe(1); expect(agg.skippedNames).toEqual(['Cloud Co (USD)']);
  });

  test('bills outside the year or without a vendor name are ignored', () => {
    const agg = aggregateVendorBills([bill({ date: '2025-03-31' }), bill({ date: '2026-04-01' }), bill({ vendor_name: '' })], FY, 'INR');
    expect(agg.rows.size).toBe(0);
  });
});

describe('Customer-tagged direct cost', () => {
  test('only expenses tagged to a customer count, at the base-currency amount', () => {
    const rows = aggregateCustomerCost([
      { customer_id: 'c1', customer_name: 'A', bcy_total: 900, total: 10, date: '2025-05-02' },
      { customer_id: '', customer_name: 'nobody', total: 5, date: '2025-05-02' },
      { customer_id: 'c1', customer_name: 'A', total: 100, date: '2025-05-20' },
    ], '2025-04-01');
    expect([...rows.keys()]).toEqual(['A']);
    expect(rows.get('A')!.m[1]).toBe(1000);
  });
});

describe('fetchAllPages — every page of a paged Zoho list', () => {
  test('reads pages until Zoho says there are no more', async () => {
    const pages = [{ items: [1, 2], hasMore: true }, { items: [3], hasMore: true }, { items: [4, 5], hasMore: false }];
    const calls: number[] = [];
    const r = await fetchAllPages(async (p) => { calls.push(p); return pages[p - 1]; });
    expect(r).toEqual({ items: [1, 2, 3, 4, 5], truncated: false });
    expect(calls).toEqual([1, 2, 3]);
  });
  test('a single page is one call', async () => {
    const fetch = jest.fn(async () => ({ items: ['a'], hasMore: false }));
    expect((await fetchAllPages(fetch)).items).toEqual(['a']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  test('the page cap is reported as truncation, not hidden', async () => {
    const r = await fetchAllPages(async () => ({ items: [1], hasMore: true }), 3);
    expect(r.items).toHaveLength(3); expect(r.truncated).toBe(true);
  });
  test('an error on any page is raised, not swallowed', async () => {
    await expect(fetchAllPages(async (p) => { if (p === 2) throw new Error('rate limited'); return { items: [p], hasMore: true }; })).rejects.toThrow('rate limited');
  });
});

describe('buildSyncNotes — plain-language notes about what limited a sync', () => {
  const fine = {
    coaTruncated: false, coaError: null,
    customers: { fetchErrors: 0, totalMonths: 12, count: 3 },
    bills: { error: null, agg: { rows: new Map(), convertedForeign: 0, skippedForeign: 0, skippedNames: [], billsSeen: 40 } },
    expensesError: null,
  };
  test('a healthy sync has nothing to report', () => expect(buildSyncNotes(fine)).toEqual([]));
  test('a failed bills fetch is said out loud (it used to leave the vendor report silently empty)', () => {
    const n = buildSyncNotes({ ...fine, bills: { ...fine.bills, error: 'Invalid URL Passed (code 5)' } });
    expect(n).toHaveLength(1); expect(n[0]).toMatch(/Vendor bills could not be fetched.*code 5.*Vendor Expense report is empty/);
  });
  test('no bills at all, skipped foreign bills, failed customer months, a partial chart and failed expenses are each reported', () => {
    const n = buildSyncNotes({
      coaTruncated: true, coaError: 'timeout',
      customers: { fetchErrors: 2, totalMonths: 12, count: 1 },
      bills: { error: null, agg: { rows: new Map(), convertedForeign: 0, skippedForeign: 2, skippedNames: ['X (USD)', 'Y (EUR)'], billsSeen: 0 } },
      expensesError: 'blocked',
    });
    expect(n.join(' | ')).toMatch(/Chart of accounts could not be read/);
    expect(n.join(' | ')).toMatch(/more pages/);
    expect(n.join(' | ')).toMatch(/2 of 12 monthly reports failed/);
    expect(n.join(' | ')).toMatch(/2 foreign-currency vendor bill\(s\).*X \(USD\), Y \(EUR\)/);
    expect(n.join(' | ')).toMatch(/no vendor bills/);
    expect(n.join(' | ')).toMatch(/Expenses could not be fetched \(blocked\)/);
  });
});
