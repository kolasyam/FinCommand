/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import type { PoolClient } from 'pg';
import { loadMigrationFiles, planMigrations, type AppliedMigration, type MigrationFile } from './migrate-core';

export const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// Arbitrary fixed key: two runners (two terminals, or db:init racing
// db:migrate) queue behind each other instead of applying the same file twice.
// Transaction-scoped on purpose — DB_HOST is Neon's PgBouncer pooler
// (transaction mode), where a session-level lock can stay stranded on a
// server connection that has since been handed to someone else.
const MIGRATION_LOCK_KEY = 7_311_842_190;

export interface RunOptions {
  dryRun?: boolean;
  /** Called for each migration before it runs — the CLI prints progress with it. */
  onApply?: (m: MigrationFile) => void;
}

export function readMigrationFiles(dir = MIGRATIONS_DIR): MigrationFile[] {
  const filenames = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  return loadMigrationFiles(filenames.map(filename => ({ filename, sql: fs.readFileSync(path.join(dir, filename), 'utf8') })));
}

async function ensureMigrationsTable(client: PoolClient) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     VARCHAR(4) PRIMARY KEY,
      name        VARCHAR(200) NOT NULL,
      checksum    CHAR(64) NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
}

/** Read-only: a database that has never been migrated simply has no rows (the table is created only when something is applied). */
export async function loadAppliedMigrations(client: PoolClient): Promise<AppliedMigration[]> {
  const { rows: [t] } = await client.query<{ exists: boolean }>(`SELECT to_regclass('schema_migrations') IS NOT NULL AS exists`);
  if (!t.exists) return [];
  const { rows } = await client.query<AppliedMigration>(`SELECT version, name, checksum FROM schema_migrations ORDER BY version`);
  return rows;
}

/**
 * Applies every pending migration in version order, each in its own
 * transaction together with its schema_migrations row — a failure rolls that
 * file back completely and stops, leaving earlier files applied. Refuses to
 * run at all if an already-applied file has been edited since.
 */
export async function runMigrations(client: PoolClient, opts: RunOptions = {}): Promise<MigrationFile[]> {
  const plan = planMigrations(readMigrationFiles(), await loadAppliedMigrations(client));
  if (plan.changed.length) {
    throw new Error(
      `Already-applied migration(s) were edited: ${plan.changed.map(c => c.filename).join(', ')}. ` +
      `Put the change in a new migration file instead.`
    );
  }
  if (plan.missing.length) {
    console.warn(`⚠  Applied in the database but not on disk: ${plan.missing.map(m => `${m.version}_${m.name}`).join(', ')}`);
  }
  if (opts.dryRun) return plan.pending;

  if (plan.pending.length) await ensureMigrationsTable(client);
  const applied: MigrationFile[] = [];
  for (const m of plan.pending) {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
      // Another runner may have applied it while this one waited for the lock.
      const { rowCount } = await client.query(`SELECT 1 FROM schema_migrations WHERE version=$1`, [m.version]);
      if (rowCount) { await client.query('COMMIT'); continue; }

      opts.onApply?.(m);
      // Backfills get more room than the app's 30s default; lock_timeout
      // stops a migration from queueing forever behind live app traffic.
      await client.query(`SET LOCAL statement_timeout = '300s'`);
      await client.query(`SET LOCAL lock_timeout = '15s'`);
      await client.query(m.sql);
      await client.query(
        `INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`,
        [m.version, m.name, m.checksum]
      );
      await client.query('COMMIT');
      applied.push(m);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`Migration ${m.filename} failed and was rolled back: ${(err as Error).message}`);
    }
  }
  return applied;
}
