/* eslint-disable no-console */
/**
 * READ-ONLY report: which superseded trial-balance batches a retention
 * policy could remove, and how much space they take. Deletes nothing — a
 * real cleanup is a later, separately-approved step.
 *
 *   npx tsx db/scripts/retention-report.ts [--target=branch] [--days=90]
 *
 * Candidates: not current, uploaded more than --days ago, and in a year that
 * is NOT locked (a locked year's history is kept as audit evidence).
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { connectionConfigFor, parseTarget } from '../migrate-core';

async function main() {
  const target = parseTarget(process.argv);
  const daysArg = process.argv.find(a => a.startsWith('--days='));
  const days = daysArg ? parseInt(daysArg.slice('--days='.length), 10) : 90;
  if (!Number.isInteger(days) || days < 1) throw new Error('--days must be a positive whole number');

  const pool = new Pool({ ...connectionConfigFor(target, process.env), max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const { rows } = await client.query(
      `WITH candidates AS (
         SELECT u.id, u.company_id, u.financial_year_id, u.source, u.uploaded_at,
                pg_column_size(u.raw_zoho_months) AS raw_bytes,
                (SELECT count(*) FROM tb_ledgers l WHERE l.upload_id = u.id) AS ledger_rows
         FROM tb_uploads u JOIN financial_years fy ON fy.id = u.financial_year_id
         WHERE u.is_current = FALSE AND fy.is_locked = FALSE
           AND u.uploaded_at < NOW() - make_interval(days => $1)
       )
       SELECT c.name AS company, fy.label AS year, cand.source,
              count(*) AS batches,
              sum(cand.ledger_rows) AS ledger_rows,
              pg_size_pretty(COALESCE(sum(cand.raw_bytes), 0)) AS raw_json,
              min(cand.uploaded_at)::date::text AS oldest, max(cand.uploaded_at)::date::text AS newest
       FROM candidates cand
       JOIN companies c ON c.id = cand.company_id
       JOIN financial_years fy ON fy.id = cand.financial_year_id
       GROUP BY c.name, fy.label, cand.source
       ORDER BY c.name, fy.label`,
      [days]
    );
    await client.query('ROLLBACK');
    console.log(`Target: ${target}. Superseded batches older than ${days} days in unlocked years (nothing is deleted):`);
    if (rows.length) console.table(rows); else console.log('  none');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`❌ ${(err as Error).message}`);
  process.exit(1);
});
