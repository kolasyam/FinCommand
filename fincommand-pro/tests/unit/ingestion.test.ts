import type { PoolClient } from 'pg';
import { ingestTrialBalance, toAmountRows, stripVolatileMetadata, type IngestInput, type NormalizedLedger } from '@/lib/ingestion/trial-balance';
import { contentHash } from '@/lib/ingestion/content-hash';

interface CurrentBatch { fileSha?: string | null; contentSha?: string | null; storedRows?: Record<string, unknown>[] }

/** A fake pg client: records every statement and answers the few SELECTs the pipeline makes. */
function fakeDb(opts: { year?: { is_locked?: boolean; data_source?: 'zoho' | 'excel' | null }; current?: CurrentBatch; failOn?: RegExp } = {}) {
  const log: { sql: string; params?: unknown[] }[] = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      log.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (opts.failOn?.test(sql)) throw new Error('boom');
      if (/FROM financial_years WHERE id=\$1 AND company_id=\$2 FOR UPDATE/.test(sql)) {
        return { rows: [{ id: 'fy1', label: 'FY 2025-26', is_locked: !!opts.year?.is_locked, data_source: opts.year?.data_source ?? null }], rowCount: 1 };
      }
      if (/SELECT id, currency, file_sha256, content_sha256 FROM tb_uploads/.test(sql)) {
        const c = opts.current;
        return { rows: c ? [{ id: 'current-batch', currency: 'INR', file_sha256: c.fileSha ?? null, content_sha256: c.contentSha ?? null }] : [], rowCount: c ? 1 : 0 };
      }
      if (/SELECT \* FROM tb_ledgers WHERE upload_id/.test(sql)) return { rows: opts.current?.storedRows ?? [], rowCount: 0 };
      if (/INSERT INTO raw_payloads/.test(sql)) return { rows: [{ id: `payload-${(params?.[2] as string).length}` }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  const deps = { transaction: <T,>(fn: (c: PoolClient) => Promise<T>) => fn(client) };
  const statements = () => log.map((l) => l.sql);
  return { deps, log, statements };
}

const ledger = (name: string, code: string | null, op: [number, number], apr: [number, number] = [0, 0]): NormalizedLedger => ({
  code, name,
  note_no: 26, note_name: 'Other Expenses', section: 'exp', treasury_type: null, normal_bal: 'Dr',
  op_dr: op[0], op_cr: op[1],
  months: Array.from({ length: 12 }, (_, i) => (i === 0 ? { dr: apr[0], cr: apr[1] } : { dr: 0, cr: 0 })),
});

const input = (over: Partial<IngestInput> = {}): IngestInput => ({
  companyId: 'co1', fyId: 'fy1', source: 'excel', uploadedBy: 'u1',
  ledgers: [ledger('Bank', '2101', [1000, 0], [300, 0]), ledger('Capital', '3001', [0, 1000]), ledger('Rent', '7041', [0, 0], [0, 300])],
  batch: { currency: 'INR', mappedCount: 3, hasMonthlyCols: true, fileSha256: 'abc' },
  ...over,
});

describe('ingestTrialBalance — the one write path for every source', () => {
  test('writes lock → checks → supersede → batch → ledgers → owner, in that order', async () => {
    const db = fakeDb();
    const r = await ingestTrialBalance(input(), db.deps);
    expect(r.status).toBe('created');
    expect(r.summary.is_balanced).toBe(true);
    const s = db.statements();
    const at = (re: RegExp) => s.findIndex((q) => re.test(q));
    expect(at(/pg_advisory_xact_lock/)).toBeGreaterThanOrEqual(0);
    expect(at(/pg_advisory_xact_lock/)).toBeLessThan(at(/UPDATE tb_uploads SET is_current=FALSE/));
    expect(at(/UPDATE tb_uploads SET is_current=FALSE/)).toBeLessThan(at(/INSERT INTO tb_uploads/));
    expect(at(/INSERT INTO tb_uploads/)).toBeLessThan(at(/INSERT INTO tb_ledgers/));
    expect(at(/INSERT INTO tb_ledgers/)).toBeLessThan(at(/UPDATE financial_years SET data_source/));
    // The batch row carries the id the result reports.
    expect(db.log.find((l) => /INSERT INTO tb_uploads/.test(l.sql))!.params![0]).toBe(r.uploadId);
  });

  test('large loads are written in chunks of 500 rows per statement', async () => {
    const many = Array.from({ length: 1201 }, (_, i) => ledger(`L${i}`, `C${i}`, [0, 0]));
    const db = fakeDb();
    await ingestTrialBalance(input({ ledgers: many }), db.deps);
    expect(db.statements().filter((q) => /INSERT INTO tb_ledgers/.test(q))).toHaveLength(3);
  });

  test('a ledger listed twice is refused before any lock is taken', async () => {
    const db = fakeDb();
    await expect(ingestTrialBalance(input({ ledgers: [ledger('Rent', '7041', [0, 0]), ledger('rent ', '7041', [0, 0])] }), db.deps))
      .rejects.toMatchObject({ status: 422, code: 'DUPLICATE_LEDGERS' });
    expect(db.log).toHaveLength(0);
  });

  test('a locked year is refused and nothing is written', async () => {
    const db = fakeDb({ year: { is_locked: true } });
    await expect(ingestTrialBalance(input(), db.deps)).rejects.toMatchObject({ status: 403, code: 'YEAR_LOCKED' });
    expect(db.statements().some((q) => /INSERT|UPDATE tb_uploads/.test(q))).toBe(false);
  });

  test('Excel into a Zoho-owned year needs confirmation; once confirmed it replaces and reports the old owner', async () => {
    await expect(ingestTrialBalance(input(), fakeDb({ year: { data_source: 'zoho' } }).deps))
      .rejects.toMatchObject({ status: 409, code: 'SOURCE_OWNED' });
    const r = await ingestTrialBalance(input({ options: { confirmReplace: true } }), fakeDb({ year: { data_source: 'zoho' } }).deps);
    expect(r.replacedSource).toBe('zoho');
  });

  test('a scheduled Zoho sync never replaces an Excel-owned year', async () => {
    await expect(ingestTrialBalance(input({ source: 'zoho', options: { scheduled: true } }), fakeDb({ year: { data_source: 'excel' } }).deps))
      .rejects.toMatchObject({ status: 409, code: 'SOURCE_OWNED' });
  });

  test('the same file as the current batch is refused', async () => {
    const db = fakeDb({ current: { fileSha: 'abc' } });
    await expect(ingestTrialBalance(input(), db.deps)).rejects.toMatchObject({ status: 409, code: 'DUPLICATE_FILE' });
    expect(db.statements().some((q) => /INSERT INTO tb_uploads/.test(q))).toBe(false);
  });

  describe('skip unchanged loads (Phase 1.2)', () => {
    const fingerprintOf = (i: IngestInput) => contentHash({
      currency: i.batch.currency,
      ledgers: i.ledgers.map((l) => ({ ...l, amounts: [l.op_dr, l.op_cr, ...l.months.flatMap((mv) => [mv.dr, mv.cr])] })),
    });

    test('a Zoho sync with the same figures writes nothing and returns the current batch', async () => {
      const zoho = input({ source: 'zoho', batch: { currency: 'INR', mappedCount: 3, hasMonthlyCols: true } });
      const db = fakeDb({ year: { data_source: 'zoho' }, current: { contentSha: fingerprintOf(zoho) } });
      const r = await ingestTrialBalance(zoho, db.deps);
      expect(r).toMatchObject({ status: 'no_change', uploadId: 'current-batch', replacedSource: null });
      expect(db.statements().some((q) => /INSERT|UPDATE tb_uploads SET is_current|UPDATE financial_years/.test(q))).toBe(false);
    });

    test('an Excel file with the same figures (different bytes) is refused with NO_CHANGE', async () => {
      const excel = input();
      const db = fakeDb({ current: { fileSha: 'another-file', contentSha: fingerprintOf(excel) } });
      await expect(ingestTrialBalance(excel, db.deps)).rejects.toMatchObject({ status: 409, code: 'NO_CHANGE' });
    });

    test('any difference is written as a new batch, carrying its own fingerprint', async () => {
      const db = fakeDb({ current: { contentSha: 'something-else' } });
      const r = await ingestTrialBalance(input(), db.deps);
      expect(r.status).toBe('created');
      const batch = db.log.find((l) => /INSERT INTO tb_uploads/.test(l.sql))!;
      expect(batch.params![batch.params!.length - 1]).toBe(fingerprintOf(input()));
    });

    test('a batch written before fingerprints existed is fingerprinted from its own rows, then cached', async () => {
      const zoho = input({ source: 'zoho', batch: { currency: 'INR', mappedCount: 3, hasMonthlyCols: true } });
      // The stored rows are exactly what the pipeline would have written (pg returns NUMERIC as strings).
      const storedRows = zoho.ledgers.map((l, i) => {
        const amounts = toAmountRows([l])[0] as Record<string, number>;
        return {
          ledger_code: l.code, ledger_name: l.name, note_no: l.note_no, note_name: l.note_name, section: l.section,
          treasury_type: l.treasury_type, normal_bal: l.normal_bal, zoho_account_id: null, zoho_account_type: null, id: `r${i}`,
          ...Object.fromEntries(Object.entries(amounts).map(([k, v]) => [k, (v ?? 0).toFixed(2)])),
        };
      });
      const db = fakeDb({ year: { data_source: 'zoho' }, current: { contentSha: null, storedRows } });
      const r = await ingestTrialBalance(zoho, db.deps);
      expect(r.status).toBe('no_change');
      expect(db.statements().some((q) => /UPDATE tb_uploads SET content_sha256/.test(q))).toBe(true);
    });
  });

  test('source-specific writes run inside the same transaction, before the batch is written', async () => {
    const db = fakeDb();
    const seen: number[] = [];
    await ingestTrialBalance(input({ inTransaction: async () => { seen.push(db.log.length); } }), db.deps);
    const batchAt = db.statements().findIndex((q) => /INSERT INTO tb_uploads/.test(q));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeLessThan(batchAt + 1);
  });

  test('a failing customer/vendor table does not lose the trial balance (savepoint, logged)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const db = fakeDb({ failOn: /INSERT INTO tb_vendor_expense/ });
    const r = await ingestTrialBalance(input({ vendorExpense: [{ externalId: 'v1', name: 'Vendor', m: Array(12).fill(1) }] }), db.deps);
    expect(r.status).toBe('created');
    expect(db.statements()).toContain('ROLLBACK TO SAVEPOINT tb_vendor_expense_sp');
    expect(db.statements().some((q) => /UPDATE financial_years SET data_source/.test(q))).toBe(true);
    warn.mockRestore();
  });

  test('raw responses are stored through the de-duplicated store and linked by label — never on the batch row', async () => {
    const db = fakeDb();
    await ingestTrialBalance(input({
      source: 'zoho',
      batch: {
        currency: 'INR', mappedCount: 3, hasMonthlyCols: true,
        rawPayloads: [
          { label: 'P&L Apr', periodFrom: '2025-04-01', periodTo: '2025-04-30', fetchedAt: null, payload: { profit_and_loss: [] } },
          { label: 'BS Opening', periodFrom: '2025-03-31', periodTo: '2025-03-31', fetchedAt: null, payload: { balance_sheet: [] } },
        ],
      },
    }), db.deps);
    const upserts = db.log.filter((l) => /INSERT INTO raw_payloads/.test(l.sql));
    const links = db.log.filter((l) => /INSERT INTO upload_raw_payloads/.test(l.sql));
    expect(upserts).toHaveLength(2);
    expect(upserts[0].sql).toMatch(/ON CONFLICT \(company_id, sha256\) DO UPDATE SET last_seen_at = NOW\(\)/);
    expect(links.map((l) => l.params![1])).toEqual(['P&L Apr', 'BS Opening']);
    expect(db.statements().find((q) => /INSERT INTO tb_uploads/.test(q))).not.toMatch(/raw_zoho_months/);
  });

  test("Zoho's per-request access timestamp is dropped before storing, so identical months de-duplicate", () => {
    const a = { code: 0, balance_sheet: [{ total: 5 }], page_context: { report_name: 'Balance Sheet', last_accessed_time_formatted: '19/09/2026 10:00' } };
    const b = { ...a, page_context: { ...a.page_context, last_accessed_time_formatted: '19/09/2026 16:00' } };
    expect(JSON.stringify(stripVolatileMetadata(a))).toBe(JSON.stringify(stripVolatileMetadata(b)));
    expect(stripVolatileMetadata(a)).toEqual({ code: 0, balance_sheet: [{ total: 5 }], page_context: { report_name: 'Balance Sheet' } });
    // Figures are never touched.
    expect(JSON.stringify(stripVolatileMetadata({ ...a, balance_sheet: [{ total: 6 }] }))).not.toBe(JSON.stringify(stripVolatileMetadata(a)));
    expect(stripVolatileMetadata([1, 2])).toEqual([1, 2]);
  });

  test('an unbalanced trial balance is still written — and its difference recorded', async () => {
    const db = fakeDb();
    const r = await ingestTrialBalance(input({ ledgers: [ledger('Bank', '2101', [1000, 0]), ledger('Capital', '3001', [0, 900])] }), db.deps);
    expect(r.summary.is_balanced).toBe(false);
    expect(r.summary.validation.opening_diff).toBe(100);
    const batch = db.log.find((l) => /INSERT INTO tb_uploads/.test(l.sql))!;
    expect(batch.params).toContain(false); // is_balanced stored
  });
});
