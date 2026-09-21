import type { PoolClient } from 'pg';
import { hashRecord, upsertListPage, writeDetail, saveSnapshot, LIST_COLUMNS } from '@/lib/ingestion/zoho-records';
import { getModule } from '@/lib/services/zoho/modules';

const bills = getModule('bills')!;
const ctx = { baseCurrency: 'INR' };

/** A fake pg client: records every statement, answers the SELECTs the writers make. */
function fakeDb(opts: { existing?: Array<{ zoho_id: string; payload_sha256: string }>; detailRow?: Record<string, unknown> | null; failOn?: RegExp } = {}) {
  const log: { sql: string; params?: unknown[] }[] = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      const s = sql.replace(/\s+/g, ' ').trim();
      log.push({ sql: s, params });
      if (opts.failOn?.test(s)) throw new Error('boom');
      if (/^SELECT zoho_id, payload_sha256 FROM zoho_records/.test(s)) return { rows: opts.existing ?? [], rowCount: (opts.existing ?? []).length };
      if (/^SELECT payload, detail, detail_sha256, revision FROM zoho_records/.test(s)) {
        return opts.detailRow === null ? { rows: [], rowCount: 0 } : { rows: [opts.detailRow ?? { payload: { bill_id: 'b1', total: 100 }, detail: null, detail_sha256: null, revision: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  const deps = { transaction: async <T,>(fn: (c: PoolClient) => Promise<T>) => fn(client) };
  const statements = () => log.map((l) => l.sql);
  return { deps, log, statements };
}

const row = (id: string, extra: Record<string, unknown> = {}) => ({ bill_id: id, bill_number: `B-${id}`, date: '2026-05-01', vendor_id: 'v1', vendor_name: 'Vendor', total: 100, currency_code: 'INR', last_modified_time: '2026-05-02T10:00:00+0530', ...extra });

describe('hashRecord', () => {
  test('does not depend on key order', () => {
    expect(hashRecord({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(hashRecord({ b: { d: [1, 2], c: 2 }, a: 1 }));
  });

  test('changes with any real value', () => {
    expect(hashRecord(row('1'))).not.toBe(hashRecord(row('1', { total: 101 })));
  });

  test('ignores fields Zoho changes only when someone looks at a document', () => {
    const a = row('1', { client_viewed_time: '', is_viewed_by_client: false });
    const b = row('1', { client_viewed_time: '2026-09-21T10:00:00+0530', is_viewed_by_client: true, reminders_sent: 3 });
    expect(hashRecord(a)).toBe(hashRecord(b));
  });

  test('is a 64-character SHA-256', () => {
    expect(hashRecord({})).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('upsertListPage', () => {
  test('new records are inserted with their typed columns and full JSON, in one transaction', async () => {
    const db = fakeDb();
    const r = await upsertListPage({ companyId: 'co1', def: bills, rows: [row('1'), row('2')], ctx }, db.deps);
    expect(r).toMatchObject({ received: 2, created: 2, updated: 0, unchanged: 0, skipped: 0 });
    const ins = db.log.find((l) => /^INSERT INTO zoho_records/.test(l.sql))!;
    const at = (col: (typeof LIST_COLUMNS)[number]) => ins.params![LIST_COLUMNS.indexOf(col)];
    expect(at('company_id')).toBe('co1');
    expect(at('module')).toBe('bills');
    expect(at('zoho_id')).toBe('1');
    expect(at('doc_number')).toBe('B-1');
    expect(at('doc_date')).toBe('2026-05-01');
    expect(at('amount')).toBe(100);
    expect(at('base_amount')).toBe(100); // INR bill in an INR company
    expect(JSON.parse(at('payload') as string).bill_id).toBe('1');
    expect(at('detail_stale')).toBe(true); // bills have detail to read
    expect(ins.params).toHaveLength(2 * LIST_COLUMNS.length);
    expect(ins.sql).toMatch(new RegExp(`\\(\\$1,.*\\$${LIST_COLUMNS.length}\\)`));
    expect(db.statements().some((q) => /UPDATE zoho_records SET last_seen_at/.test(q))).toBe(false);
  });

  test('an unchanged record writes nothing but its seen time', async () => {
    const db = fakeDb({ existing: [{ zoho_id: '1', payload_sha256: hashRecord(row('1')) }] });
    const r = await upsertListPage({ companyId: 'co1', def: bills, rows: [row('1')], ctx }, db.deps);
    expect(r).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    expect(db.statements().some((q) => /^INSERT INTO zoho_records/.test(q))).toBe(false);
    expect(db.statements().some((q) => /^UPDATE zoho_records SET last_seen_at=NOW\(\), deleted_at=NULL/.test(q))).toBe(true);
  });

  test('a changed record has its previous version copied to history BEFORE it is overwritten', async () => {
    const db = fakeDb({ existing: [{ zoho_id: '1', payload_sha256: 'old' }] });
    const r = await upsertListPage({ companyId: 'co1', def: bills, rows: [row('1', { total: 999 })], ctx }, db.deps);
    expect(r).toMatchObject({ updated: 1, created: 0 });
    const s = db.statements();
    const hist = s.findIndex((q) => /^INSERT INTO zoho_record_history/.test(q));
    const up = s.findIndex((q) => /^INSERT INTO zoho_records/.test(q));
    expect(hist).toBeGreaterThanOrEqual(0);
    expect(hist).toBeLessThan(up);
  });

  test('rows without an id are counted as skipped, and a repeated id is stored once', async () => {
    const db = fakeDb();
    const r = await upsertListPage({ companyId: 'co1', def: bills, rows: [row('1'), { bill_number: 'no id' }, row('1')], ctx }, db.deps);
    expect(r).toMatchObject({ received: 3, created: 1, skipped: 1 });
  });

  test('large pages are written in chunks of 100 rows', async () => {
    const db = fakeDb();
    const many = Array.from({ length: 250 }, (_, i) => row(String(i)));
    await upsertListPage({ companyId: 'co1', def: bills, rows: many, ctx }, db.deps);
    expect(db.statements().filter((q) => /^INSERT INTO zoho_records/.test(q))).toHaveLength(3);
  });

  test('bank transactions listed for two accounts with the same id are stored as two rows', async () => {
    const tx = getModule('banktransactions')!;
    const db = fakeDb();
    const r1 = await upsertListPage({ companyId: 'co1', def: tx, rows: [{ transaction_id: 'T1', account_id: 'a1', amount: 5, date: '2026-08-01' }], ctx, parentId: 'a1' }, db.deps);
    const r2 = await upsertListPage({ companyId: 'co1', def: tx, rows: [{ transaction_id: 'T1', account_id: 'a2', amount: 5, date: '2026-08-01' }], ctx, parentId: 'a2' }, db.deps);
    expect([r1.created, r2.created]).toEqual([1, 1]);
    const inserts = db.log.filter((l) => /^INSERT INTO zoho_records/.test(l.sql));
    const ids = inserts.map((l) => l.params![LIST_COLUMNS.indexOf('zoho_id')]);
    const parents = inserts.map((l) => l.params![LIST_COLUMNS.indexOf('parent_id')]);
    expect(ids).toEqual(['a1:T1', 'a2:T1']);
    expect(parents).toEqual(['a1', 'a2']);
    // and the existence check looked for the composite id, not the bare one
    expect(db.log.find((l) => /^SELECT zoho_id, payload_sha256/.test(l.sql))!.params![2]).toEqual(['a1:T1']);
  });

  test('an empty page opens no transaction', async () => {
    const db = fakeDb();
    const r = await upsertListPage({ companyId: 'co1', def: bills, rows: [], ctx }, db.deps);
    expect(r.created).toBe(0);
    expect(db.log).toHaveLength(0);
  });

  test('the upsert keeps detail-derived columns unless Zoho\'s modified time moved, and re-flags detail only then', async () => {
    const db = fakeDb();
    await upsertListPage({ companyId: 'co1', def: bills, rows: [row('1')], ctx }, db.deps);
    const sql = db.log.find((l) => /^INSERT INTO zoho_records/.test(l.sql))!.sql;
    expect(sql).toMatch(/base_amount = CASE WHEN zoho_records\.zoho_modified_at IS DISTINCT FROM EXCLUDED\.zoho_modified_at/);
    expect(sql).toMatch(/detail_stale = zoho_records\.detail_stale OR \(EXCLUDED\.detail_stale AND zoho_records\.zoho_modified_at IS DISTINCT FROM EXCLUDED\.zoho_modified_at\)/);
    expect(sql).toMatch(/deleted_at=NULL/);
  });

  test('every statement is scoped to the company', async () => {
    const db = fakeDb({ existing: [{ zoho_id: '1', payload_sha256: 'old' }] });
    await upsertListPage({ companyId: 'co1', def: bills, rows: [row('1'), row('2')], ctx }, db.deps);
    for (const l of db.log) expect(l.params![0]).toBe('co1');
  });

  test('a failure inside the transaction propagates (the real helper rolls back)', async () => {
    const db = fakeDb({ failOn: /^INSERT INTO zoho_records/ });
    await expect(upsertListPage({ companyId: 'co1', def: bills, rows: [row('1')], ctx }, db.deps)).rejects.toThrow('boom');
  });
});

describe('saveSnapshot', () => {
  const snapDb = (inserted: boolean) => {
    const log: { sql: string; params?: unknown[] }[] = [];
    const client = { async query(sql: string, params?: unknown[]) { log.push({ sql: sql.replace(/\s+/g, ' ').trim(), params }); return { rows: [{ inserted }], rowCount: 1 }; } } as unknown as PoolClient;
    return { log, deps: { transaction: async <T,>(fn: (c: PoolClient) => Promise<T>) => fn(client) } };
  };

  test('new content for a period is a new snapshot; the same content only moves its "last seen"', async () => {
    const a = snapDb(true);
    expect(await saveSnapshot({ companyId: 'co1', report: 'taxsummary', periodFrom: '2025-04-01', periodTo: '2026-03-31', payload: { tax: [1] } }, a.deps)).toBe('created');
    const b = snapDb(false);
    expect(await saveSnapshot({ companyId: 'co1', report: 'taxsummary', periodFrom: '2025-04-01', periodTo: '2026-03-31', payload: { tax: [1] } }, b.deps)).toBe('unchanged');
    expect(b.log[0]!.sql).toMatch(/ON CONFLICT \(company_id, report, COALESCE\(period_from, DATE '0001-01-01'\), period_to, payload_sha256\) DO UPDATE SET last_seen_at = NOW\(\)/);
  });

  test('is scoped to the company and hashes the content', async () => {
    const a = snapDb(true);
    await saveSnapshot({ companyId: 'co1', report: 'aragingsummary', periodFrom: null, periodTo: '2026-09-21', payload: { invoice: {} } }, a.deps);
    expect(a.log[0]!.params![0]).toBe('co1');
    expect(a.log[0]!.params![2]).toBeNull();
    expect(a.log[0]!.params![5]).toBe(hashRecord({ invoice: {} }));
  });
});

describe('writeDetail', () => {
  const detail = {
    bill_id: 'b1', total: 100, gst_treatment: 'business_gst', source_of_supply: 'KA',
    line_items: [
      { line_item_id: 'l1', account_name: 'Rent', item_total: 60, hsn_or_sac: '9972', line_item_taxes: [{ tax_amount: 10.8 }] },
      { line_item_id: 'l2', account_name: 'Power', item_total: 40 },
    ],
  };

  test('stores the detail, fills GST columns, replaces the lines, in that order', async () => {
    const db = fakeDb();
    const out = await writeDetail({ companyId: 'co1', def: bills, zohoId: 'b1', detail, ctx }, db.deps);
    expect(out).toBe('updated');
    const s = db.statements();
    const at = (re: RegExp) => s.findIndex((q) => re.test(q));
    expect(at(/FOR UPDATE/)).toBeLessThan(at(/^UPDATE zoho_records SET detail=/));
    expect(at(/^UPDATE zoho_records SET detail=/)).toBeLessThan(at(/^DELETE FROM zoho_record_lines/));
    expect(at(/^DELETE FROM zoho_record_lines/)).toBeLessThan(at(/^INSERT INTO zoho_record_lines/));
    const upd = db.log.find((l) => /^UPDATE zoho_records SET detail=/.test(l.sql))!;
    expect(upd.params).toContain('business_gst');
    expect(upd.params).toContain('KA');
    const ins = db.log.find((l) => /^INSERT INTO zoho_record_lines/.test(l.sql))!;
    expect(ins.params!.filter((p) => p === 'bills')).toHaveLength(2);
    expect(ins.params).toContain('9972');
    expect(ins.params).toContain(10.8);
  });

  test('a first detail is not put in history (there was none)', async () => {
    const db = fakeDb();
    await writeDetail({ companyId: 'co1', def: bills, zohoId: 'b1', detail, ctx }, db.deps);
    expect(db.statements().some((q) => /^INSERT INTO zoho_record_history/.test(q))).toBe(false);
  });

  test('a changed detail first copies the previous one to history', async () => {
    const db = fakeDb({ detailRow: { payload: { bill_id: 'b1' }, detail: { bill_id: 'b1', total: 90 }, detail_sha256: 'old', revision: 2 } });
    await writeDetail({ companyId: 'co1', def: bills, zohoId: 'b1', detail, ctx }, db.deps);
    const s = db.statements();
    expect(s.findIndex((q) => /^INSERT INTO zoho_record_history/.test(q))).toBeGreaterThanOrEqual(0);
    expect(s.findIndex((q) => /^INSERT INTO zoho_record_history/.test(q))).toBeLessThan(s.findIndex((q) => /^UPDATE zoho_records SET detail=/.test(q)));
  });

  test('an identical detail only clears the "stale" flag and leaves the lines alone', async () => {
    const db = fakeDb({ detailRow: { payload: { bill_id: 'b1' }, detail, detail_sha256: hashRecord(detail), revision: 2 } });
    const out = await writeDetail({ companyId: 'co1', def: bills, zohoId: 'b1', detail, ctx }, db.deps);
    expect(out).toBe('unchanged');
    expect(db.statements().some((q) => /zoho_record_lines/.test(q))).toBe(false);
  });

  test('a record that is not stored yet reports "missing" and writes nothing', async () => {
    const db = fakeDb({ detailRow: null });
    expect(await writeDetail({ companyId: 'co1', def: bills, zohoId: 'nope', detail, ctx }, db.deps)).toBe('missing');
    expect(db.statements().some((q) => /^(UPDATE|DELETE|INSERT)/.test(q))).toBe(false);
  });
});
