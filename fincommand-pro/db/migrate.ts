/* eslint-disable no-console */
/**
 * SQL migration runner.
 *
 *   npx tsx db/migrate.ts --target=branch --dry-run   list what would run on the Neon test branch
 *   npx tsx db/migrate.ts --target=branch             apply there (BRANCH_DATABASE_URL)
 *   npx tsx db/migrate.ts --target=main               apply to production
 *   npx tsx db/migrate.ts --target=branch --status    applied / pending per file
 *
 * --target is REQUIRED (no default). Call tsx directly rather than via
 * `npm run … -- …`: Windows PowerShell's npm shim drops the `--`, and the
 * flags never reach this script.
 *
 * Only the target name is printed, never a host, user or password.
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { connectionConfigFor, parseTarget } from './migrate-core';
import { loadAppliedMigrations, readMigrationFiles, runMigrations } from './migrate-runner';

async function main() {
  const argv = process.argv.slice(2);
  const target = parseTarget(argv);
  const statusOnly = argv.includes('--status');
  const dryRun = argv.includes('--dry-run');

  const pool = new Pool({ ...connectionConfigFor(target, process.env), max: 1 });
  const client = await pool.connect();
  // RAISE NOTICE lines from migration pre-flight/post-checks.
  client.on('notice', (n) => console.log(`   · ${n.message}`));
  try {
    console.log(`Target: ${target}`);
    if (statusOnly) {
      const applied = new Map((await loadAppliedMigrations(client)).map(a => [a.version, a]));
      for (const f of readMigrationFiles()) {
        const a = applied.get(f.version);
        const state = !a ? 'pending' : a.checksum === f.checksum ? 'applied' : 'APPLIED BUT EDITED SINCE';
        console.log(`  ${f.filename.padEnd(40)} ${state}`);
      }
      return;
    }

    const result = await runMigrations(client, {
      dryRun,
      onApply: (m) => console.log(`→ applying ${m.filename}`),
    });
    if (dryRun) {
      console.log(result.length ? `Would apply: ${result.map(m => m.filename).join(', ')}` : 'Nothing to apply.');
    } else {
      console.log(result.length ? `✅ Applied ${result.length} migration(s).` : '✅ Already up to date.');
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
