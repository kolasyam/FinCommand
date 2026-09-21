import type { PoolClient } from 'pg';
import { extractBankTransaction, bankTxnRecordId, parseBankTxnRecordId } from '@/lib/services/zoho/bank-transactions';
import { upsertBankTransactionsPage, BANK_COLUMNS } from '@/lib/ingestion/zoho-bank-transactions';
import { hashRecord } from '@/lib/ingestion/zoho-records';
import { getModule, usesBankTable, ZOHO_MODULES } from '@/lib/services/zoho/modules';

const txn = (id: string, extra: Record<string, unknown> = {}) => ({
  transaction_id: id, account_id: 'a1', account_name: 'HDFC Current', date: '2026-08-31', amount: 1500.5, debit_or_credit: 'Debit',
  transaction_type: 'deposit', status: 'categorized', payee: 'Some Vendor', reference_number: 'UTR1', description: 'Rent', offset_account_name: 'Rent',
  currency_code: 'inr', running_balance: 2000, ...extra,
});

describe('extractBankTransaction', () => {
  test('typed columns come from the row; debit/credit and currency are normalised', () => {
    expect(extractBankTransaction(txn('t1'))).toEqual({
      accountId: 'a1', txnId: 't1', accountName: 'HDFC Current', txnDate: '2026-08-31', amount: 1500.5, debitOrCredit: 'debit',
      transactionType: 'deposit', status: 'categorized', payee: 'Some Vendor', customerId: null, referenceNumber: 'UTR1', description: 'Rent',
      offsetAccountName: 'Rent', currencyCode: 'INR', runningBalance: 2000,
    });
  });

  test('the account a page was listed for wins over what the row says', () => {
    expect(extractBankTransaction(txn('t1', { account_id: 'other' }), 'queried')!.accountId).toBe('queried');
  });

  test('a row without a transaction id, or with no account at all, cannot be stored', () => {
    expect(extractBankTransaction({ account_id: 'a1' })).toBeNull();
    expect(extractBankTransaction({ transaction_id: 't1' })).toBeNull();
    expect(extractBankTransaction({ transaction_id: 't1' }, 'a9')!.accountId).toBe('a9');
  });

  test('odd values become null rather than wrong numbers', () => {
    const t = extractBankTransaction(txn('t1', { date: 'yesterday', amount: 'n/a', debit_or_credit: 'sideways', running_balance: '' }))!;
    expect(t).toMatchObject({ txnDate: null, amount: null, debitOrCredit: null, runningBalance: null });
  });
});

describe('the "<account>:<transaction>" id', () => {
  test('round trips, and refuses anything that is not one', () => {
    expect(bankTxnRecordId('a1', 't9')).toBe('a1:t9');
    expect(parseBankTxnRecordId('a1:t9')).toEqual({ accountId: 'a1', txnId: 't9' });
    for (const bad of ['', 'a1', ':t9', 'a1:']) expect(parseBankTxnRecordId(bad)).toBeNull();
  });
});

describe('the registry', () => {
  test('bank transactions use their own table; nothing else does', () => {
    expect(usesBankTable('banktransactions')).toBe(true);
    expect(getModule('banktransactions')!.store).toBe('bank_transactions');
    expect(ZOHO_MODULES.filter((m) => m.store === 'bank_transactions').map((m) => m.key)).toEqual(['banktransactions']);
    expect(usesBankTable('bills')).toBe(false);
    expect(usesBankTable('nonsense')).toBe(false);
  });
});

/** A fake pg client that answers the writer's one SELECT. */
function fakeDb(existing: Array<{ txn_id: string; payload_sha256: string }> = []) {
  const log: { sql: string; params?: unknown[] }[] = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      const s = sql.replace(/\s+/g, ' ').trim();
      log.push({ sql: s, params });
      if (/^SELECT txn_id, payload_sha256 FROM zoho_bank_transactions/.test(s)) return { rows: existing, rowCount: existing.length };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  return { log, deps: { transaction: async <T,>(fn: (c: PoolClient) => Promise<T>) => fn(client) } };
}
const at = (params: unknown[], col: (typeof BANK_COLUMNS)[number], row = 0) => params[row * BANK_COLUMNS.length + BANK_COLUMNS.indexOf(col)];

describe('upsertBankTransactionsPage', () => {
  test('new transactions are inserted with typed columns and the full JSON, scoped to the company and account', async () => {
    const db = fakeDb();
    const r = await upsertBankTransactionsPage({ companyId: 'co1', rows: [txn('t1'), txn('t2')], parentId: 'a1' }, db.deps);
    expect(r).toMatchObject({ received: 2, created: 2, updated: 0, unchanged: 0, skipped: 0 });
    const ins = db.log.find((l) => /^INSERT INTO zoho_bank_transactions/.test(l.sql))!;
    expect(ins.params).toHaveLength(2 * BANK_COLUMNS.length);
    expect(at(ins.params!, 'company_id')).toBe('co1');
    expect(at(ins.params!, 'account_id')).toBe('a1');
    expect(at(ins.params!, 'txn_id')).toBe('t1');
    expect(at(ins.params!, 'txn_date')).toBe('2026-08-31');
    expect(at(ins.params!, 'amount')).toBe(1500.5);
    expect(at(ins.params!, 'debit_or_credit')).toBe('debit');
    expect(JSON.parse(at(ins.params!, 'payload') as string).transaction_id).toBe('t1');
    expect(at(ins.params!, 'payload_sha256')).toBe(hashRecord(txn('t1')));
    expect(ins.sql).toMatch(/ON CONFLICT \(company_id, account_id, txn_id\) DO UPDATE/);
  });

  test('every statement targets the bank table, never the generic records table, and is scoped to the company', async () => {
    const db = fakeDb([{ txn_id: 't1', payload_sha256: 'old' }]);
    await upsertBankTransactionsPage({ companyId: 'co1', rows: [txn('t1', { amount: 9 }), txn('t2')], parentId: 'a1' }, db.deps);
    for (const l of db.log) {
      expect(l.sql).not.toMatch(/FROM zoho_records|INTO zoho_records\b/);
      expect(l.params![0]).toBe('co1');
    }
  });

  test('an unchanged transaction writes nothing but its seen time', async () => {
    const db = fakeDb([{ txn_id: 't1', payload_sha256: hashRecord(txn('t1')) }]);
    const r = await upsertBankTransactionsPage({ companyId: 'co1', rows: [txn('t1')], parentId: 'a1' }, db.deps);
    expect(r).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    expect(db.log.some((l) => /^INSERT INTO zoho_bank_transactions/.test(l.sql))).toBe(false);
    expect(db.log.some((l) => /^UPDATE zoho_bank_transactions SET last_seen_at=NOW\(\), deleted_at=NULL/.test(l.sql))).toBe(true);
  });

  test('a changed transaction has its previous version copied to history BEFORE it is overwritten, under the "<account>:<id>" key', async () => {
    const db = fakeDb([{ txn_id: 't1', payload_sha256: 'old' }]);
    const r = await upsertBankTransactionsPage({ companyId: 'co1', rows: [txn('t1', { amount: 999 })], parentId: 'a1' }, db.deps);
    expect(r).toMatchObject({ updated: 1, created: 0 });
    const s = db.log.map((l) => l.sql);
    const hist = s.findIndex((q) => /^INSERT INTO zoho_record_history/.test(q));
    const up = s.findIndex((q) => /^INSERT INTO zoho_bank_transactions/.test(q));
    expect(hist).toBeGreaterThanOrEqual(0);
    expect(hist).toBeLessThan(up);
    expect(s[hist]).toContain(`account_id || ':' || txn_id`);
    expect(s[hist]).toContain(`'banktransactions'`);
  });

  test('the same transaction id under two bank accounts is two rows (a transfer shows on both sides)', async () => {
    const db = fakeDb();
    await upsertBankTransactionsPage({ companyId: 'co1', rows: [txn('T1', { account_id: 'a1' })], parentId: 'a1' }, db.deps);
    await upsertBankTransactionsPage({ companyId: 'co1', rows: [txn('T1', { account_id: 'a2' })], parentId: 'a2' }, db.deps);
    const inserts = db.log.filter((l) => /^INSERT INTO zoho_bank_transactions/.test(l.sql));
    expect(inserts.map((l) => [at(l.params!, 'account_id'), at(l.params!, 'txn_id')])).toEqual([['a1', 'T1'], ['a2', 'T1']]);
    const lookups = db.log.filter((l) => /^SELECT txn_id/.test(l.sql));
    expect(lookups.map((l) => l.params![1])).toEqual(['a1', 'a2']);
  });

  test('without a parent, rows are grouped by their own account', async () => {
    const db = fakeDb();
    await upsertBankTransactionsPage({ companyId: 'co1', rows: [txn('t1', { account_id: 'a1' }), txn('t2', { account_id: 'a2' })] }, db.deps);
    expect(db.log.filter((l) => /^INSERT INTO zoho_bank_transactions/.test(l.sql)).map((l) => at(l.params!, 'account_id'))).toEqual(['a1', 'a2']);
  });

  test('rows without an id are counted as skipped; a repeated id is stored once', async () => {
    const db = fakeDb();
    const r = await upsertBankTransactionsPage({ companyId: 'co1', rows: [txn('t1'), { account_id: 'a1' }, txn('t1')], parentId: 'a1' }, db.deps);
    expect(r).toMatchObject({ received: 3, created: 1, skipped: 1 });
  });

  test('large pages are written in chunks of 100 rows', async () => {
    const db = fakeDb();
    await upsertBankTransactionsPage({ companyId: 'co1', rows: Array.from({ length: 250 }, (_, i) => txn(`t${i}`)), parentId: 'a1' }, db.deps);
    expect(db.log.filter((l) => /^INSERT INTO zoho_bank_transactions/.test(l.sql))).toHaveLength(3);
  });

  test('an empty page opens no transaction', async () => {
    const db = fakeDb();
    await upsertBankTransactionsPage({ companyId: 'co1', rows: [], parentId: 'a1' }, db.deps);
    expect(db.log).toHaveLength(0);
  });

  test('the hash ignores look-only fields and key order, like every other record', () => {
    expect(hashRecord({ a: 1, b: 2 })).toBe(hashRecord({ b: 2, a: 1 }));
  });
});
