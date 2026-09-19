/* eslint-disable no-console */
/**
 * Empties the old tb_uploads.raw_zoho_months column (DB Phase 1.3 / 1.6) for
 * batches whose raw Zoho responses are safely in the de-duplicated store
 * (raw_payloads + upload_raw_payloads, migration 0004). A batch is listed
 * only if EVERY entry of its old column is reachable through its links with
 * identical JSON and identical label, period and fetch time, and the entry
 * holds nothing else — so clearing loses no information. Batches in a locked
 * year are left as they are. The column itself stays (dropping it is a later
 * migration).
 *
 *   npx tsx db/scripts/clear-raw-zoho-months.ts --target=branch --dry-run
 *   npx tsx db/scripts/clear-raw-zoho-months.ts --target=branch --apply --confirm=<list id>
 *   (--target=main the same way — only with a list id the owner approved)
 *
 * Apply = one transaction under the app's trial-balance write locks, and only
 * if the recomputed list still has the approved id (script-support.ts).
 * Audited in audit_trail, one row per company. Postgres returns the space to
 * the table as autovacuum runs. Prints no connection details.
 */
import 'dotenv/config';
import { Pool, type PoolClient } from 'pg';
import { connectionConfigFor, parseTarget } from '../migrate-core';
import { auditScriptChange, listId, lockCompanyYears, parseRunMode } from './script-support';

interface Row {
  id: string; company_id: string; company: string; financial_year_id: string; year: string;
  is_current: boolean; entries: number; verified: number; bytes: number; decision: string;
}
interface Plan { rows: Row[]; clear: Row[]; id: string }

async function buildPlan(client: PoolClient): Promise<Plan> {
  const { rows } = await client.query<Row>(
    `WITH v AS (
       SELECT u.id, u.company_id, c.name AS company, u.financial_year_id, fy.label AS year, u.is_current, fy.is_locked,
              pg_column_size(u.raw_zoho_months)::int AS bytes,
              CASE WHEN jsonb_typeof(u.raw_zoho_months) = 'array' THEN jsonb_array_length(u.raw_zoho_months) END AS entries,
              CASE WHEN jsonb_typeof(u.raw_zoho_months) = 'array' THEN (
                SELECT count(*)::int FROM jsonb_array_elements(u.raw_zoho_months) e(val)
                JOIN upload_raw_payloads l ON l.upload_id = u.id AND l.label = e.val->>'month'
                JOIN raw_payloads p ON p.id = l.raw_payload_id AND p.company_id = u.company_id
                WHERE p.payload = e.val->'raw_response'
                  AND l.period_from IS NOT DISTINCT FROM NULLIF(e.val->>'from_date', '')::date
                  AND l.period_to IS NOT DISTINCT FROM NULLIF(e.val->>'to_date', '')::date
                  AND l.fetched_at IS NOT DISTINCT FROM NULLIF(e.val->>'fetched_at', '')::timestamptz
                  AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(e.val) k
                                  WHERE k NOT IN ('month', 'from_date', 'to_date', 'raw_response', 'fetched_at'))
              ) END AS verified
       FROM tb_uploads u
       JOIN financial_years fy ON fy.id = u.financial_year_id AND fy.company_id = u.company_id
       JOIN companies c ON c.id = u.company_id
       WHERE u.raw_zoho_months IS NOT NULL
     )
     SELECT id, company_id, company, financial_year_id, year, is_current, bytes,
            COALESCE(entries, -1) AS entries, COALESCE(verified, 0) AS verified,
            CASE WHEN is_locked THEN 'keep: locked year'
                 WHEN entries IS NULL THEN 'keep: not a list — cannot verify'
                 WHEN verified <> entries THEN 'keep: only ' || verified || ' of ' || entries || ' entries verified'
                 ELSE 'clear' END AS decision
     FROM v ORDER BY company, year, id`,
  );
  const clear = rows.filter((r) => r.decision === 'clear');
  return { rows, clear, id: listId({ clear: clear.map((r) => r.id) }) };
}

function print(plan: Plan, target: string) {
  console.log(`Target: ${target}. Batches that still carry the old raw_zoho_months column: ${plan.rows.length}`);
  const perYear = new Map<string, Record<string, number | string>>();
  for (const r of plan.rows) {
    const key = `${r.company} | ${r.year}`;
    const s = perYear.get(key) ?? { 'company | year': key, entries: 0, kB: 0 };
    s[r.decision] = ((s[r.decision] as number) ?? 0) + 1;
    s.entries = (s.entries as number) + Math.max(r.entries, 0);
    s.kB = Math.round(((s.kB as number) + r.bytes / 1024) * 10) / 10;
    perYear.set(key, s);
  }
  console.table([...perYear.values()]);
  console.log(`Would CLEAR the old column on ${plan.clear.length} batch(es) (${plan.clear.filter((r) => r.is_current).length} current), `
    + `${plan.clear.reduce((s, r) => s + r.entries, 0)} entries, all verified in the new store.`);
  const kept = plan.rows.filter((r) => r.decision !== 'clear');
  if (kept.length) console.table(kept.map((r) => ({ batch: r.id, company: r.company, year: r.year, why: r.decision })));
  console.log(`LIST ID: ${plan.id}`);
}

async function main() {
  const target = parseTarget(process.argv);
  const mode = parseRunMode(process.argv);

  const pool = new Pool({ ...connectionConfigFor(target, process.env), max: 1 });
  const client = await pool.connect();
  try {
    if (!mode.apply) {
      await client.query('BEGIN READ ONLY');
      print(await buildPlan(client), target);
      await client.query('ROLLBACK');
      console.log('Dry run — nothing was changed.');
      return;
    }

    await client.query('BEGIN');
    try {
      await lockCompanyYears(client, (await buildPlan(client)).rows);
      const plan = await buildPlan(client);
      if (plan.id !== mode.confirm) {
        throw new Error(`The list is now ${plan.id}, not the approved ${mode.confirm} — it changed since the dry run. Nothing was changed; run the dry run again and re-approve.`);
      }
      if (!plan.clear.length) {
        await client.query('ROLLBACK');
        console.log('Nothing to clear.');
        return;
      }
      const upd = await client.query(
        `UPDATE tb_uploads SET raw_zoho_months = NULL WHERE id = ANY($1::uuid[]) AND raw_zoho_months IS NOT NULL`,
        [plan.clear.map((r) => r.id)],
      );
      if (upd.rowCount !== plan.clear.length) throw new Error(`Cleared ${upd.rowCount} of ${plan.clear.length} batches — rolled back.`);
      for (const companyId of new Set(plan.clear.map((r) => r.company_id))) {
        const mine = plan.clear.filter((r) => r.company_id === companyId);
        await auditScriptChange(client, companyId, 'TB_RAW_JSON_CLEARED',
          { batches: mine.map(({ id, year, entries, bytes }) => ({ id, year, entries, bytes })) },
          { list_id: plan.id, kept_in: 'raw_payloads + upload_raw_payloads (migration 0004)' },
        );
      }
      await client.query('COMMIT');
      print(plan, target);
      console.log(`✅ Cleared the old column on ${plan.clear.length} batch(es); their raw responses remain in the new store.`);
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
