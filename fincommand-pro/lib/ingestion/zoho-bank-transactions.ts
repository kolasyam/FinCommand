import type { PoolClient } from 'pg';
import { withTransaction } from '@/lib/db/neon';
import { extractBankTransaction, bankTxnRecordId, BANK_TXN_MODULE, type BankTransaction } from '@/lib/services/zoho/bank-transactions';
import { hashRecord, type PageResult, type RecordsDeps } from './zoho-records';

/**
 * The write path for zoho_bank_transactions (migration 0009): the same rules as the generic records
 * writer - one transaction per page, safe to retry, an unchanged row writes nothing but its "seen" time,
 * a changed row first copies its old version to zoho_record_history - keyed by (account, transaction).
 */
type Obj = Record<string, unknown>;
const defaultDeps: RecordsDeps = { transaction: withTransaction };
const CHUNK = 100;

export const BANK_COLUMNS = [
  'company_id', 'account_id', 'txn_id', 'account_name', 'txn_date', 'amount', 'debit_or_credit', 'transaction_type', 'status', 'payee',
  'customer_id', 'reference_number', 'description', 'offset_account_name', 'currency_code', 'running_balance', 'payload', 'payload_sha256',
] as const;

function bankRowValues(companyId: string, t: BankTransaction, row: Obj, sha: string): unknown[] {
  return [
    companyId, t.accountId, t.txnId, t.accountName, t.txnDate, t.amount, t.debitOrCredit, t.transactionType, t.status, t.payee,
    t.customerId, t.referenceNumber, t.description, t.offsetAccountName, t.currencyCode, t.runningBalance, JSON.stringify(row), sha,
  ];
}

/** Stores one page of a bank account's transaction list. `skipped` counts rows that cannot be stored (no id). */
export async function upsertBankTransactionsPage(
  input: { companyId: string; rows: Obj[]; parentId?: string | null },
  deps: RecordsDeps = defaultDeps,
): Promise<PageResult> {
  const { companyId, rows } = input;
  const result: PageResult = { received: rows.length, created: 0, updated: 0, unchanged: 0, skipped: 0 };

  const byAccount = new Map<string, Array<{ t: BankTransaction; row: Obj; sha: string }>>();
  const seen = new Set<string>();
  for (const row of rows) {
    const t = extractBankTransaction(row, input.parentId);
    if (!t) { result.skipped++; continue; }
    const key = bankTxnRecordId(t.accountId, t.txnId);
    if (seen.has(key)) continue; // Zoho can repeat a row across pages while data shifts
    seen.add(key);
    const list = byAccount.get(t.accountId) ?? [];
    list.push({ t, row, sha: hashRecord(row) });
    byAccount.set(t.accountId, list);
  }
  if (!seen.size) return result;

  return deps.transaction(async (c: PoolClient) => {
    for (const [accountId, items] of byAccount) {
      const ids = items.map((i) => i.t.txnId);
      const { rows: existing } = await c.query(
        `SELECT txn_id, payload_sha256 FROM zoho_bank_transactions WHERE company_id=$1 AND account_id=$2 AND txn_id = ANY($3::text[])`,
        [companyId, accountId, ids]
      );
      const known = new Map<string, string>(existing.map((r: { txn_id: string; payload_sha256: string }) => [r.txn_id, r.payload_sha256]));

      const unchangedIds: string[] = [];
      const changedIds: string[] = [];
      const toWrite: typeof items = [];
      for (const it of items) {
        const sha = known.get(it.t.txnId);
        if (sha === undefined) { toWrite.push(it); result.created++; }
        else if (sha === it.sha) { unchangedIds.push(it.t.txnId); result.unchanged++; }
        else { toWrite.push(it); changedIds.push(it.t.txnId); result.updated++; }
      }

      if (unchangedIds.length) {
        await c.query(
          `UPDATE zoho_bank_transactions SET last_seen_at=NOW(), deleted_at=NULL WHERE company_id=$1 AND account_id=$2 AND txn_id = ANY($3::text[])`,
          [companyId, accountId, unchangedIds]
        );
      }
      if (changedIds.length) {
        await c.query(
          `INSERT INTO zoho_record_history (company_id, module, zoho_id, revision, payload)
           SELECT company_id, '${BANK_TXN_MODULE}', account_id || ':' || txn_id, revision, payload FROM zoho_bank_transactions
            WHERE company_id=$1 AND account_id=$2 AND txn_id = ANY($3::text[])`,
          [companyId, accountId, changedIds]
        );
      }
      for (let i = 0; i < toWrite.length; i += CHUNK) {
        const chunk = toWrite.slice(i, i + CHUNK);
        const params: unknown[] = [];
        const tuples = chunk.map(({ t, row, sha }) => {
          const base = params.length;
          params.push(...bankRowValues(companyId, t, row, sha));
          return `(${BANK_COLUMNS.map((col, k) => `$${base + k + 1}${col === 'payload' ? '::jsonb' : ''}`).join(',')})`;
        });
        await c.query(
          `INSERT INTO zoho_bank_transactions (${BANK_COLUMNS.join(', ')})
           VALUES ${tuples.join(', ')}
           ON CONFLICT (company_id, account_id, txn_id) DO UPDATE SET
             account_name=EXCLUDED.account_name, txn_date=EXCLUDED.txn_date, amount=EXCLUDED.amount, debit_or_credit=EXCLUDED.debit_or_credit,
             transaction_type=EXCLUDED.transaction_type, status=EXCLUDED.status, payee=EXCLUDED.payee, customer_id=EXCLUDED.customer_id,
             reference_number=EXCLUDED.reference_number, description=EXCLUDED.description, offset_account_name=EXCLUDED.offset_account_name,
             currency_code=EXCLUDED.currency_code, running_balance=EXCLUDED.running_balance,
             payload=EXCLUDED.payload, payload_sha256=EXCLUDED.payload_sha256,
             revision = zoho_bank_transactions.revision + 1, last_seen_at=NOW(), deleted_at=NULL`,
          params
        );
      }
    }
    return result;
  });
}
