/**
 * Shared by the data-changing maintenance scripts (retention.ts,
 * clear-raw-zoho-months.ts): the dry-run → owner approval → apply gate.
 *
 * A dry run prints the exact list of what would change and a LIST ID (a
 * fingerprint of that list). --apply recomputes the list inside its
 * transaction, under the same write locks the app takes, and changes nothing
 * unless the id still matches --confirm — so exactly the approved list is
 * applied, never a list that grew or shifted since it was reviewed.
 */
import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { tbWriteLockKey } from '../../lib/db/tb-write-lock';

export interface RunMode { apply: boolean; confirm: string | null }

/** Exactly one of --dry-run / --apply; --apply needs --confirm=<list id>. No default. */
export function parseRunMode(argv: string[]): RunMode {
  const dryRun = argv.includes('--dry-run');
  const apply = argv.includes('--apply');
  const confirm = argv.find((a) => a.startsWith('--confirm='))?.slice('--confirm='.length) || null;
  if (dryRun === apply) throw new Error('Say which: --dry-run (list only) or --apply --confirm=<list id>. There is no default.');
  if (apply && !confirm) throw new Error('--apply needs --confirm=<list id> — the id printed by the dry run the owner approved.');
  if (dryRun && confirm) throw new Error('--confirm only goes with --apply.');
  return { apply, confirm };
}

/** Whole-number option with a floor, e.g. --days=90. */
export function intArg(argv: string[], name: string, fallback: number, min: number): number {
  const raw = argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be a whole number ≥ ${min} (got "${raw}")`);
  return n;
}

/** Fingerprint of a change list — order-independent within each array. */
export function listId(parts: Record<string, string[] | number | string>): string {
  const canonical = Object.fromEntries(Object.keys(parts).sort().map((k) => {
    const v = parts[k];
    return [k, Array.isArray(v) ? [...v].sort() : v];
  }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 12);
}

/**
 * Takes the trial-balance write lock (lockTrialBalanceWrite's key) of every
 * listed company-year, in a fixed order, then row-locks those years so a
 * year lock can't slip in. Inside a transaction; released at COMMIT/ROLLBACK.
 */
export async function lockCompanyYears(client: PoolClient, pairs: { company_id: string; financial_year_id: string }[]): Promise<void> {
  await client.query(`SET LOCAL lock_timeout = '15s'`);
  const keys = [...new Set(pairs.map((p) => tbWriteLockKey(p.company_id, p.financial_year_id)))].sort();
  for (const key of keys) await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
  await client.query(
    `SELECT id FROM financial_years WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [[...new Set(pairs.map((p) => p.financial_year_id))]],
  );
}

/** The permanent record of a script's change, one audit_trail row per company. */
export async function auditScriptChange(
  client: PoolClient, companyId: string, action: string, oldValues: unknown, metadata: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_trail (company_id, user_id, user_name, user_role, action, entity_type, old_values, metadata)
     VALUES ($1, NULL, 'Maintenance script', 'system', $2, 'tb_upload', $3::jsonb, $4::jsonb)`,
    [companyId, action, JSON.stringify(oldValues), JSON.stringify(metadata)],
  );
}
