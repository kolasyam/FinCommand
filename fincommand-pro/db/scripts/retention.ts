/* eslint-disable no-console */
/**
 * Removes OLD COPIES of trial balances (superseded batches) under the
 * owner-approved safe-window policy — DB Phase 1.6. It always KEEPS:
 *   • the current batch of every company + year (never touched);
 *   • the newest --keep (default 5) superseded batches of each company + year;
 *   • any batch that was current at some point in the last --days (default 90);
 *   • every batch in a locked year (audit evidence).
 * Deleting a batch removes its ledger / customer / vendor rows and its raw
 * payload links (ON DELETE CASCADE). Stored raw responses that no batch links
 * to any more are removed with it. Ledger accounts (the stable identities
 * Report Builder links to) are never removed.
 *
 *   npx tsx db/scripts/retention.ts --target=branch --dry-run
 *   npx tsx db/scripts/retention.ts --target=branch --apply --confirm=<list id>
 *   (--target=main the same way — only with a list id the owner approved)
 *
 * Apply = one transaction under the app's trial-balance write locks, and only
 * if the recomputed list still has the approved id (script-support.ts).
 * Audited in audit_trail, one row per company. Prints no connection details.
 */
import 'dotenv/config';
import { Pool, type PoolClient } from 'pg';
import { connectionConfigFor, parseTarget } from '../migrate-core';
import { auditScriptChange, intArg, listId, lockCompanyYears, parseRunMode } from './script-support';

interface BatchRow {
  id: string; company_id: string; company: string; financial_year_id: string; year: string;
  source: string; filename: string | null; uploaded_at: string; replaced_at: string | null;
  ledger_rows: number; decision: string;
}
interface Plan { batches: BatchRow[]; doomed: BatchRow[]; payloads: { id: string; company_id: string }[]; id: string }

async function buildPlan(client: PoolClient, days: number, keep: number): Promise<Plan> {
  // No batch is ever made current again, so a superseded batch stopped being
  // current when the next one for the same company + year was uploaded.
  const { rows: batches } = await client.query<BatchRow>(
    `WITH b AS (
       SELECT u.id, u.company_id, u.financial_year_id, u.source, u.filename, u.uploaded_at, u.is_current,
              fy.is_locked, fy.label AS year, c.name AS company,
              lag(u.uploaded_at) OVER w AS replaced_at,
              row_number() OVER (PARTITION BY u.company_id, u.financial_year_id, u.is_current
                                 ORDER BY u.uploaded_at DESC, u.id DESC) AS newest_rank
       FROM tb_uploads u
       JOIN financial_years fy ON fy.id = u.financial_year_id AND fy.company_id = u.company_id
       JOIN companies c ON c.id = u.company_id
       WINDOW w AS (PARTITION BY u.company_id, u.financial_year_id ORDER BY u.uploaded_at DESC, u.id DESC)
     )
     SELECT id, company_id, company, financial_year_id, year, source, filename,
            uploaded_at::text, replaced_at::text,
            (SELECT count(*)::int FROM tb_ledgers l WHERE l.upload_id = b.id) AS ledger_rows,
            CASE WHEN is_current THEN 'keep: current'
                 WHEN is_locked THEN 'keep: locked year'
                 WHEN newest_rank <= $2 THEN 'keep: newest ' || $2
                 WHEN replaced_at IS NULL OR replaced_at >= NOW() - make_interval(days => $1) THEN 'keep: within ' || $1 || ' days'
                 ELSE 'delete' END AS decision
     FROM b ORDER BY company, year, uploaded_at DESC, id DESC`,
    [days, keep],
  );
  const doomed = batches.filter((b) => b.decision === 'delete');
  // Stored responses nothing will link to once those batches are gone (incl. any already unlinked).
  const { rows: payloads } = await client.query<{ id: string; company_id: string }>(
    `SELECT p.id, p.company_id FROM raw_payloads p
     WHERE NOT EXISTS (SELECT 1 FROM upload_raw_payloads l
                       WHERE l.raw_payload_id = p.id AND NOT (l.upload_id = ANY($1::uuid[])))
     ORDER BY p.company_id, p.id`,
    [doomed.map((b) => b.id)],
  );
  return {
    batches, doomed, payloads,
    id: listId({ policy: `${days}d/${keep}`, batches: doomed.map((b) => b.id), payloads: payloads.map((p) => p.id) }),
  };
}

function print(plan: Plan, target: string, days: number, keep: number) {
  console.log(`Target: ${target}. Policy: keep the current batch, the newest ${keep} superseded, anything current in the last ${days} days, and locked years.`);
  const perYear = new Map<string, Record<string, number | string>>();
  for (const b of plan.batches) {
    const key = `${b.company} | ${b.year}`;
    const r = perYear.get(key) ?? { 'company | year': key };
    r[b.decision] = ((r[b.decision] as number) ?? 0) + 1;
    perYear.set(key, r);
  }
  console.table([...perYear.values()]);
  if (plan.doomed.length) {
    console.log(`Would DELETE ${plan.doomed.length} superseded batch(es) and their ${plan.doomed.reduce((s, b) => s + b.ledger_rows, 0)} ledger rows:`);
    console.table(plan.doomed.map((b) => ({
      batch: b.id, company: b.company, year: b.year, source: b.source,
      uploaded: b.uploaded_at.slice(0, 16), replaced: b.replaced_at?.slice(0, 16), rows: b.ledger_rows,
    })));
  } else {
    console.log('No batch is old enough to delete under this policy.');
  }
  console.log(`Stored raw responses that would be left unused and removed: ${plan.payloads.length}`);
  console.log(`LIST ID: ${plan.id}`);
}

async function main() {
  const target = parseTarget(process.argv);
  const mode = parseRunMode(process.argv);
  const days = intArg(process.argv, 'days', 90, 1);
  const keep = intArg(process.argv, 'keep', 5, 0);

  const pool = new Pool({ ...connectionConfigFor(target, process.env), max: 1 });
  const client = await pool.connect();
  try {
    if (!mode.apply) {
      await client.query('BEGIN READ ONLY');
      print(await buildPlan(client, days, keep), target, days, keep);
      await client.query('ROLLBACK');
      console.log('Dry run — nothing was changed.');
      return;
    }

    await client.query('BEGIN');
    try {
      // Lock every year of every company the list could touch, then recompute under the locks.
      const first = await buildPlan(client, days, keep);
      const companies = [...new Set([...first.doomed.map((b) => b.company_id), ...first.payloads.map((p) => p.company_id)])];
      const { rows: years } = await client.query<{ company_id: string; financial_year_id: string }>(
        `SELECT company_id, id AS financial_year_id FROM financial_years WHERE company_id = ANY($1::uuid[])`, [companies],
      );
      await lockCompanyYears(client, years);
      const plan = await buildPlan(client, days, keep);
      if (plan.id !== mode.confirm) {
        throw new Error(`The list is now ${plan.id}, not the approved ${mode.confirm} — it changed since the dry run. Nothing was deleted; run the dry run again and re-approve.`);
      }
      if (!plan.doomed.length && !plan.payloads.length) {
        await client.query('ROLLBACK');
        console.log('Nothing to delete.');
        return;
      }

      const currentBefore = (await client.query(`SELECT count(*)::int AS n FROM tb_uploads WHERE is_current`)).rows[0].n;
      const del = await client.query(
        `DELETE FROM tb_uploads WHERE id = ANY($1::uuid[]) AND is_current = FALSE`, [plan.doomed.map((b) => b.id)],
      );
      if (del.rowCount !== plan.doomed.length) throw new Error(`Deleted ${del.rowCount} of ${plan.doomed.length} batches — rolled back.`);
      const delP = await client.query(
        `DELETE FROM raw_payloads p WHERE p.id = ANY($1::uuid[])
           AND NOT EXISTS (SELECT 1 FROM upload_raw_payloads l WHERE l.raw_payload_id = p.id)`,
        [plan.payloads.map((p) => p.id)],
      );
      if (delP.rowCount !== plan.payloads.length) throw new Error(`Removed ${delP.rowCount} of ${plan.payloads.length} raw responses — rolled back.`);
      const currentAfter = (await client.query(`SELECT count(*)::int AS n FROM tb_uploads WHERE is_current`)).rows[0].n;
      if (currentAfter !== currentBefore) throw new Error('A current batch went missing — rolled back.');

      for (const companyId of companies) {
        const mine = plan.doomed.filter((b) => b.company_id === companyId);
        await auditScriptChange(client, companyId, 'TB_RETENTION_DELETE',
          { batches: mine.map(({ id, year, source, filename, uploaded_at, replaced_at, ledger_rows }) => ({ id, year, source, filename, uploaded_at, replaced_at, ledger_rows })) },
          { list_id: plan.id, policy: { days, keep }, raw_payloads_removed: plan.payloads.filter((p) => p.company_id === companyId).length },
        );
      }
      await client.query('COMMIT');
      print(plan, target, days, keep);
      console.log(`✅ Deleted ${plan.doomed.length} batch(es) and ${plan.payloads.length} unused raw response(s). Current batches untouched (${currentAfter}).`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`❌ ${(err as Error).message}`);
  process.exit(1);
});
