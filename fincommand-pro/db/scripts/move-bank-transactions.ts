/**
 * Moves bank transactions from the generic zoho_records table into their own partitioned table
 * (zoho_bank_transactions, migration 0009). Two SEPARATE steps, each behind the dry-run -> list id gate:
 *
 *   --copy         copies every module='banktransactions' row into the new table (insert-only into an EMPTY
 *                  target; refuses otherwise), then compares a content fingerprint of both sides before commit.
 *   --retire-old   removes the old copies from zoho_records - only where the new table holds the identical set
 *                  (verified again in the same transaction). Needs the owner's approval of the printed list.
 *
 *   npx tsx db/scripts/move-bank-transactions.ts --target=branch --copy --dry-run
 *   npx tsx db/scripts/move-bank-transactions.ts --target=branch --copy --apply --confirm=<list id>
 *   npx tsx db/scripts/move-bank-transactions.ts --target=main   --retire-old --dry-run
 *   npx tsx db/scripts/move-bank-transactions.ts --target=main   --retire-old --apply --confirm=<list id>
 *
 * No default target, no default step. Prints counts and fingerprints only - no record contents.
 */
import 'dotenv/config';
import type { PoolClient } from 'pg';
import { Pool } from 'pg';
import { parseRunMode, listId } from './script-support';
import { upsertBankTransactionsPage } from '../../lib/ingestion/zoho-bank-transactions';

interface Fp { n: number; h: string }

/** Fingerprint of the OLD copies: "<account>:<txn>:<payload sha>" in id order. */
async function oldFp(c: PoolClient, companyId: string): Promise<Fp> {
  const { rows } = await c.query(
    `SELECT count(*)::int AS n, md5(coalesce(string_agg(zoho_id || ':' || payload_sha256, '|' ORDER BY zoho_id), '')) AS h
       FROM zoho_records WHERE company_id = $1 AND module = 'banktransactions'`, [companyId]);
  return rows[0] as Fp;
}
/** The same string for the NEW table, so equal sets give equal fingerprints. */
async function newFp(c: PoolClient, companyId: string): Promise<Fp> {
  const { rows } = await c.query(
    `SELECT count(*)::int AS n, md5(coalesce(string_agg(account_id || ':' || txn_id || ':' || payload_sha256, '|' ORDER BY account_id || ':' || txn_id), '')) AS h
       FROM zoho_bank_transactions WHERE company_id = $1`, [companyId]);
  return rows[0] as Fp;
}

async function main() {
  const argv = process.argv.slice(2);
  const mode = parseRunMode(argv);
  const target = argv.find((a) => a.startsWith('--target='))?.slice('--target='.length);
  const copy = argv.includes('--copy');
  const retire = argv.includes('--retire-old');
  if (target !== 'main' && target !== 'branch') throw new Error('Say --target=main or --target=branch. There is no default.');
  if (copy === retire) throw new Error('Say exactly one of --copy or --retire-old.');

  const pool = target === 'branch'
    ? new Pool({ connectionString: process.env.BRANCH_DATABASE_URL, ssl: { rejectUnauthorized: false } })
    : new Pool({ host: process.env.DB_HOST, port: +(process.env.DB_PORT || 5432), database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
  if (target === 'branch' && !process.env.BRANCH_DATABASE_URL) throw new Error('BRANCH_DATABASE_URL is not set');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL TIME ZONE 'UTC'`);
    await c.query(`SET LOCAL lock_timeout = '15s'`);
    await c.query(`LOCK TABLE zoho_records, zoho_bank_transactions IN SHARE ROW EXCLUSIVE MODE`);

    const { rows: comps } = await c.query<{ company_id: string }>(
      `SELECT DISTINCT company_id FROM zoho_records WHERE module = 'banktransactions' UNION SELECT DISTINCT company_id FROM zoho_bank_transactions ORDER BY 1`);
    const plan: Array<{ companyId: string; old: Fp; nw: Fp }> = [];
    for (const { company_id } of comps) plan.push({ companyId: company_id, old: await oldFp(c, company_id), nw: await newFp(c, company_id) });

    const id = listId({ step: copy ? 'copy' : 'retire', ...Object.fromEntries(plan.map((p) => [p.companyId, `${p.old.n}:${p.old.h}|${p.nw.n}:${p.nw.h}`])) });
    console.table(plan.map((p) => ({ company: p.companyId.slice(0, 8), oldCopies: p.old.n, inNewTable: p.nw.n, sameContent: p.old.n === p.nw.n && p.old.h === p.nw.h })));
    console.log(`STEP: ${copy ? 'copy into zoho_bank_transactions' : 'retire the old copies in zoho_records'}   LIST ID: ${id}`);

    if (copy) {
      const blocked = plan.filter((p) => p.nw.n > 0);
      if (blocked.length) throw new Error(`the new table already has rows for ${blocked.length} company(ies) - this step only fills an empty table`);
    } else {
      const notSame = plan.filter((p) => p.old.n > 0 && !(p.old.n === p.nw.n && p.old.h === p.nw.h));
      if (notSame.length) throw new Error(`the new table does not hold the identical set for ${notSame.length} company(ies) - copy first, and never retire otherwise`);
    }
    if (!mode.apply) { console.log('dry run only: nothing was written.'); await c.query('ROLLBACK'); return; }
    if (mode.confirm !== id) throw new Error(`--confirm=${mode.confirm} does not match the current list id ${id}; nothing was written.`);

    if (copy) {
      for (const p of plan.filter((x) => x.old.n > 0)) {
        // One account at a time, through the same writer the sync uses, inside THIS transaction.
        const deps = { transaction: async <T,>(fn: (cl: PoolClient) => Promise<T>) => fn(c) };
        const { rows: accounts } = await c.query<{ parent_id: string }>(
          `SELECT DISTINCT parent_id FROM zoho_records WHERE company_id = $1 AND module = 'banktransactions' AND parent_id IS NOT NULL ORDER BY 1`, [p.companyId]);
        let copied = 0;
        for (const { parent_id } of accounts) {
          const { rows } = await c.query<{ payload: Record<string, unknown> }>(
            `SELECT payload FROM zoho_records WHERE company_id = $1 AND module = 'banktransactions' AND parent_id = $2 ORDER BY zoho_id`, [p.companyId, parent_id]);
          for (let i = 0; i < rows.length; i += 500) {
            const r = await upsertBankTransactionsPage({ companyId: p.companyId, rows: rows.slice(i, i + 500).map((x) => x.payload), parentId: parent_id }, deps);
            if (r.skipped) throw new Error(`${r.skipped} row(s) could not be stored (no transaction id)`);
            copied += r.created;
          }
        }
        // Keep each transaction's own history of being seen, its revision and any removal flag.
        await c.query(
          `UPDATE zoho_bank_transactions t SET first_seen_at = s.first_seen_at, last_seen_at = s.last_seen_at, revision = s.revision, deleted_at = s.deleted_at
             FROM zoho_records s
            WHERE t.company_id = $1 AND s.company_id = t.company_id AND s.module = 'banktransactions' AND s.zoho_id = t.account_id || ':' || t.txn_id`, [p.companyId]);
        const after = await newFp(c, p.companyId);
        if (after.n !== p.old.n || after.h !== p.old.h) throw new Error(`company ${p.companyId.slice(0, 8)}: the copy differs from the original (fingerprint) - rolled back`);
        const badTyped = Number((await c.query(
          `SELECT count(*)::int n FROM zoho_bank_transactions WHERE company_id = $1 AND amount IS DISTINCT FROM NULLIF(payload->>'amount','')::numeric`, [p.companyId])).rows[0].n);
        if (badTyped) throw new Error(`company ${p.companyId.slice(0, 8)}: ${badTyped} row(s) whose typed amount differs from Zoho's JSON amount - rolled back`);
        console.log(`copied ${copied} transactions for company ${p.companyId.slice(0, 8)}: fingerprint identical, typed amounts equal the JSON`);
      }
    } else {
      for (const p of plan.filter((x) => x.old.n > 0)) {
        const del = await c.query(`DELETE FROM zoho_records WHERE company_id = $1 AND module = 'banktransactions'`, [p.companyId]);
        if (del.rowCount !== p.old.n) throw new Error(`removed ${del.rowCount} of ${p.old.n} - rolled back`);
        console.log(`removed ${del.rowCount} old copies for company ${p.companyId.slice(0, 8)} (the new table holds the identical set)`);
      }
    }
    await c.query(
      `INSERT INTO audit_trail (company_id, user_id, user_name, user_role, action, entity_type, metadata)
       SELECT DISTINCT company_id, NULL::uuid, 'Maintenance script', 'system', $1, 'zoho_records', $2::jsonb FROM (SELECT unnest($3::uuid[]) AS company_id) x`,
      [copy ? 'BANK_TRANSACTIONS_COPIED' : 'BANK_TRANSACTIONS_OLD_COPIES_REMOVED', JSON.stringify({ listId: id }), plan.filter((p) => p.old.n > 0).map((p) => p.companyId)]);
    await c.query('COMMIT');
    console.log('DONE: committed.');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}
main().catch((e) => { console.error('MOVE ERROR:', (e as Error).message); process.exit(1); });
