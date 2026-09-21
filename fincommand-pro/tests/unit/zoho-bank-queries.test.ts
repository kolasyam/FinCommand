const mockQuery = jest.fn();
jest.mock('@/lib/db/neon', () => ({ query: (...a: unknown[]) => mockQuery(...a) }));

import { countSeenSince, markMissingRemoved, moduleCounts, listRecords, getRecord } from '@/lib/db/queries/zoho-records';

const sqlOf = (i: number) => String(mockQuery.mock.calls[i]![0]).replace(/\s+/g, ' ');
const paramsOf = (i: number) => mockQuery.mock.calls[i]![1] as unknown[];
beforeEach(() => mockQuery.mockReset());

describe('bank transactions are read from their own table', () => {
  test('counting what was seen in a pass', async () => {
    mockQuery.mockResolvedValue({ rows: [{ seen: '3', total: '5' }] });
    expect(await countSeenSince('co1', 'banktransactions', new Date('2026-09-21T00:00:00Z'))).toEqual({ seen: 3, total: 5 });
    expect(sqlOf(0)).toMatch(/FROM zoho_bank_transactions WHERE company_id=\$1 AND deleted_at IS NULL/);
    expect(sqlOf(0)).not.toMatch(/zoho_records/);
  });

  test('other modules still count in zoho_records', async () => {
    mockQuery.mockResolvedValue({ rows: [{ seen: '1', total: '1' }] });
    await countSeenSince('co1', 'bills', new Date());
    expect(sqlOf(0)).toMatch(/FROM zoho_records WHERE company_id=\$1 AND module=\$2/);
  });

  test('flagging removals after a complete listing (flagged, never deleted)', async () => {
    mockQuery.mockResolvedValue({ rowCount: 2 });
    expect(await markMissingRemoved('co1', 'banktransactions', new Date())).toBe(2);
    expect(sqlOf(0)).toMatch(/^UPDATE zoho_bank_transactions SET deleted_at=NOW\(\)/);
    expect(sqlOf(0)).not.toMatch(/DELETE/);
    expect(paramsOf(0)[0]).toBe('co1');
  });

  test('the module counts take the bank number from the new table, overriding any old copy in zoho_records', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [
        { module: 'banktransactions', records: '3062', removed: '0', with_detail: '0', detail_pending: '0', detail_failed: '0' },
        { module: 'bills', records: '417', removed: '0', with_detail: '417', detail_pending: '0', detail_failed: '0' },
      ] })
      .mockResolvedValueOnce({ rows: [{ records: '3341', removed: '4' }] });
    const c = await moduleCounts('co1');
    expect(c.get('banktransactions')).toMatchObject({ records: 3341, removed: 4, with_detail: 0 });
    expect(c.get('bills')).toMatchObject({ records: 417 });
    expect(sqlOf(1)).toMatch(/FROM zoho_bank_transactions WHERE company_id=\$1/);
  });

  test('the listing keeps the API\'s shape (composite id, doc_number, contact_name) and filters by account, date, payee', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ zoho_id: 'a1:t1' }] }).mockResolvedValueOnce({ rows: [{ n: '7' }] });
    const r = await listRecords('co1', { module: 'banktransactions', parentId: 'a1', from: '2026-08-01', to: '2026-08-31', q: 'vend_or%', status: 'categorized', page: 2, perPage: 10 });
    expect(r).toEqual({ records: [{ zoho_id: 'a1:t1' }], total: 7, page: 2, per_page: 10 });
    const list = sqlOf(0);
    expect(list).toMatch(/account_id \|\| ':' \|\| txn_id AS zoho_id/);
    expect(list).toMatch(/reference_number AS doc_number/);
    expect(list).toMatch(/payee AS contact_name/);
    expect(list).toMatch(/FROM zoho_bank_transactions WHERE company_id=\$1 AND deleted_at IS NULL/);
    expect(list).toMatch(/account_id = \$\d/);
    expect(list).toMatch(/txn_date >= \$\d::date/);
    // a transaction id repeats across accounts, so the order needs the account to be a total (stable) order for paging
    expect(list).toMatch(/ORDER BY txn_date DESC NULLS LAST, account_id, txn_id LIMIT 10 OFFSET 10/);
    // Zoho's base-currency figure is the document's own amount when it is in the company's base currency (as before the move)
    expect(list).toMatch(/CASE WHEN currency_code = \(SELECT upper\(currency\) FROM companies WHERE id = \$1\) THEN amount END AS base_amount/);
    expect(paramsOf(0)[0]).toBe('co1');
    expect(paramsOf(0)).toContain('%vend\\_or\\%%'); // wildcards in the search text are escaped
    expect(list).not.toMatch(/zoho_records/);
  });

  test('a single transaction is found by its "<account>:<id>" and comes back with no lines or detail', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ zoho_id: 'a1:t1', payload: { transaction_id: 't1' } }] });
    const rec = await getRecord('co1', 'banktransactions', 'a1:t1');
    expect(rec).toMatchObject({ zoho_id: 'a1:t1', detail: null, lines: [] });
    expect(sqlOf(0)).toMatch(/FROM zoho_bank_transactions WHERE company_id=\$1 AND account_id=\$2 AND txn_id=\$3/);
    expect(paramsOf(0)).toEqual(['co1', 'a1', 't1']);
  });

  test('an id that is not "<account>:<id>" is simply not found, without a query', async () => {
    expect(await getRecord('co1', 'banktransactions', 'nonsense')).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('the list order is exactly what an index provides (0010), so a page is read off the index instead of sorting the whole company', async () => {
    const fs = await import('fs'); const path = await import('path');
    const ddl = fs.readFileSync(path.join(process.cwd(), 'db', 'migrations', '0010_zoho_bank_transactions_list_indexes.sql'), 'utf8').replace(/--[^\n]*/g, '').replace(/\s+/g, ' ');
    expect(ddl).toContain('(company_id, txn_date DESC NULLS LAST, account_id, txn_id)');
    expect(ddl).toContain('(company_id, account_id, txn_date DESC NULLS LAST, txn_id)');
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ n: '0' }] });
    await listRecords('co1', { module: 'banktransactions' });
    expect(sqlOf(0)).toContain('ORDER BY txn_date DESC NULLS LAST, account_id, txn_id');
  });

  test('other modules are listed from zoho_records as before', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ n: '0' }] });
    await listRecords('co1', { module: 'bills' });
    expect(sqlOf(0)).toMatch(/FROM zoho_records WHERE company_id=\$1 AND module=\$2/);
  });
});
