/**
 * Sets (or removes) the password of the restricted database login fincommand_app (migration 0008).
 *
 *   npx tsx db/scripts/set-app-role-password.ts --target=main --generate     new random password -> your CLIPBOARD (never printed)
 *   npx tsx db/scripts/set-app-role-password.ts --target=main --from-env     password taken from APP_ROLE_PASSWORD
 *   npx tsx db/scripts/set-app-role-password.ts --target=main --disable      remove the password: the role can no longer log in
 *   (--target=branch does the same on the Neon test branch)
 *
 * The password is never printed or logged. After --generate, paste it into:
 *   - Vercel -> Project -> Settings -> Environment Variables:  DB_APP_USER = fincommand_app   DB_APP_PASSWORD = <paste>
 *   - your local .env only if you want local runs to enforce row-level security too (not needed).
 * To switch enforcement OFF again, delete those two variables (the database rules can stay).
 * No default target: a missing flag stops the script.
 */
import 'dotenv/config';
import { randomBytes } from 'crypto';
import { spawnSync } from 'child_process';
import { Pool } from 'pg';

function copyToClipboard(text: string): boolean {
  const attempts: Array<[string, string[]]> = process.platform === 'win32' ? [['clip', []]] : process.platform === 'darwin' ? [['pbcopy', []]] : [['xclip', ['-selection', 'clipboard']], ['wl-copy', []]];
  for (const [cmd, args] of attempts) {
    const r = spawnSync(cmd, args, { input: text, shell: process.platform === 'win32' });
    if (r.status === 0) return true;
  }
  return false;
}

async function main() {
  const argv = process.argv.slice(2);
  const target = argv.find((a) => a.startsWith('--target='))?.slice('--target='.length);
  const generate = argv.includes('--generate');
  const fromEnv = argv.includes('--from-env');
  const disable = argv.includes('--disable');
  if (target !== 'main' && target !== 'branch') throw new Error('Say --target=main or --target=branch. There is no default.');
  if ([generate, fromEnv, disable].filter(Boolean).length !== 1) throw new Error('Say exactly one of --generate, --from-env, --disable.');

  let pool: Pool;
  if (target === 'branch') {
    if (!process.env.BRANCH_DATABASE_URL) throw new Error('BRANCH_DATABASE_URL is not set');
    pool = new Pool({ connectionString: process.env.BRANCH_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  } else {
    pool = new Pool({
      host: process.env.DB_HOST, port: +(process.env.DB_PORT || 5432), database: process.env.DB_NAME,
      user: process.env.DB_USER, password: process.env.DB_PASSWORD, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });
  }
  try {
    const { rows } = await pool.query(`SELECT 1 FROM pg_roles WHERE rolname = 'fincommand_app'`);
    if (!rows.length) throw new Error('the role fincommand_app does not exist on this database yet - apply migration 0008 first');

    if (disable) {
      await pool.query(`ALTER ROLE fincommand_app WITH PASSWORD NULL`);
      console.log(`fincommand_app on ${target}: password removed - the role can no longer log in.`);
      return;
    }
    let password: string;
    if (generate) password = randomBytes(32).toString('hex');
    else {
      password = process.env.APP_ROLE_PASSWORD ?? '';
      if (password.length < 24) throw new Error('APP_ROLE_PASSWORD must be set and at least 24 characters (use --generate for a strong random one)');
      if (!/^[A-Za-z0-9._~-]+$/.test(password)) throw new Error('APP_ROLE_PASSWORD may contain only letters, digits and . _ ~ - (it goes into a connection string)');
    }
    // The password is a validated [A-Za-z0-9._~-] string (a random hex string, or checked above), so it is safe inside the literal.
    await pool.query(`ALTER ROLE fincommand_app WITH PASSWORD '${password}'`);
    if (generate) {
      if (copyToClipboard(password)) console.log(`fincommand_app on ${target}: new password set and COPIED TO YOUR CLIPBOARD (not shown). Paste it into Vercel as DB_APP_PASSWORD, with DB_APP_USER=fincommand_app.`);
      else { console.log('The password was set but could not be copied to the clipboard; run the script again with --generate (it will set a new one).'); process.exitCode = 1; }
    } else {
      console.log(`fincommand_app on ${target}: password set from APP_ROLE_PASSWORD.`);
    }
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error('ERROR:', (e as Error).message); process.exit(1); });
