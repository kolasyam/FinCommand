import { createHash } from 'crypto';
import type { PoolConfig } from 'pg';

/**
 * Pure helpers for the SQL migration runner (db/migrate.ts). No database or
 * filesystem access here, so the ordering/checksum rules are unit-testable.
 *
 * Migrations are plain SQL files named `NNNN_snake_case_name.sql` in
 * db/migrations. Each one is applied once, in version order, inside its own
 * transaction, and recorded in `schema_migrations` with a checksum — editing
 * a file after it has been applied is refused rather than silently ignored.
 */

export interface MigrationFile {
  version: string;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
}

export interface MigrationPlan {
  pending: MigrationFile[];
  /** Applied files whose content has changed since they were applied. */
  changed: { version: string; filename: string }[];
  /** Versions recorded in the database with no matching file on disk. */
  missing: AppliedMigration[];
}

const FILENAME_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export function parseMigrationFilename(filename: string): { version: string; name: string } | null {
  const m = FILENAME_RE.exec(filename);
  return m ? { version: m[1], name: m[2] } : null;
}

/** Line endings are normalised first, so a git autocrlf checkout doesn't look like an edit. */
export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** Builds the ordered migration list; throws on a malformed name or a duplicate version. */
export function loadMigrationFiles(files: { filename: string; sql: string }[]): MigrationFile[] {
  const out: MigrationFile[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (!f.filename.endsWith('.sql')) continue;
    const parsed = parseMigrationFilename(f.filename);
    if (!parsed) throw new Error(`Bad migration filename "${f.filename}" — expected NNNN_snake_case_name.sql`);
    if (seen.has(parsed.version)) throw new Error(`Duplicate migration version ${parsed.version}`);
    seen.add(parsed.version);
    out.push({ ...parsed, filename: f.filename, sql: f.sql, checksum: migrationChecksum(f.sql) });
  }
  return out.sort((a, b) => a.version.localeCompare(b.version));
}

export function planMigrations(files: MigrationFile[], applied: AppliedMigration[]): MigrationPlan {
  const appliedByVersion = new Map(applied.map(a => [a.version, a]));
  const fileVersions = new Set(files.map(f => f.version));
  const pending: MigrationFile[] = [];
  const changed: MigrationPlan['changed'] = [];
  for (const f of files) {
    const a = appliedByVersion.get(f.version);
    if (!a) pending.push(f);
    else if (a.checksum !== f.checksum) changed.push({ version: f.version, filename: f.filename });
  }
  const missing = applied.filter(a => !fileVersions.has(a.version));
  return { pending, changed, missing };
}

export type MigrationTarget = 'main' | 'branch';

/**
 * The target must always be written out — there is NO default. It used to
 * default to main, and on 2026-09-19 Windows PowerShell's npm shim dropped
 * `-- --target=branch --dry-run`, so migrations meant for the test branch ran
 * on production. A lost argument must fail, never fall back to main.
 */
export function parseTarget(argv: string[]): MigrationTarget {
  const arg = argv.find(a => a.startsWith('--target='));
  if (!arg) {
    throw new Error('Say which database: --target=branch (the Neon test branch) or --target=main (production). There is no default.');
  }
  const value = arg.slice('--target='.length);
  if (value !== 'main' && value !== 'branch') throw new Error(`--target must be "main" or "branch" (got "${value}")`);
  return value;
}

/**
 * Connection settings for a target. `branch` uses BRANCH_DATABASE_URL (a
 * Neon test branch); `main` uses DATABASE_URL when set, otherwise the
 * DB_* variables — the same precedence as lib/db/neon.ts. Never logs values.
 */
export function connectionConfigFor(target: MigrationTarget, env: NodeJS.ProcessEnv): PoolConfig {
  const ssl = env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined;
  if (target === 'branch') {
    if (!env.BRANCH_DATABASE_URL) throw new Error('BRANCH_DATABASE_URL is not set in .env');
    return { connectionString: env.BRANCH_DATABASE_URL, ssl: ssl ?? { rejectUnauthorized: false } };
  }
  if (env.DATABASE_URL) return { connectionString: env.DATABASE_URL, ssl };
  return {
    host: env.DB_HOST || 'localhost',
    port: parseInt(env.DB_PORT || '5432'),
    database: env.DB_NAME || 'fincommand',
    user: env.DB_USER || 'fincommand_user',
    password: env.DB_PASSWORD,
    ssl,
  };
}
