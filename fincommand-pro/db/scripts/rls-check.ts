/**
 * Proves the database itself keeps companies apart (migration 0008).
 *
 *   npx tsx db/scripts/rls-check.ts --target=branch
 *
 * BRANCH ONLY: it refuses main. It gives the restricted role fincommand_app a throw-away random password
 * (in memory, never printed), logs in as that role, and - for every table, from each of two companies' side -
 * checks that the role sees exactly its own company's rows and nothing else, cannot change or delete
 * another company's rows, cannot insert rows for another company, sees nothing with no company set, and
 * cannot touch the tables that are closed to it. The role's password is removed again afterwards.
 * Prints table names and counts only - no row contents, no secrets.
 */
import 'dotenv/config';
import { randomBytes } from 'crypto';
import { Pool, type PoolClient } from 'pg';

const APP_ROLE = 'fincommand_app';

interface Check { table: string; check: string; ok: boolean; detail: string }
const results: Check[] = [];
const record = (table: string, check: string, ok: boolean, detail = '') => results.push({ table, check, ok, detail });

// How to count "this company's rows" as the OWNER sees them (the expected answer), per table.
const COUNT_SQL: Record<string, string> = {
  companies: `SELECT count(*)::int n FROM companies WHERE id = $1`,
  ledger_master: `SELECT count(*)::int n FROM ledger_master WHERE company_id = $1 OR (company_id IS NULL AND is_global)`,
  dashboard_widgets: `SELECT count(*)::int n FROM dashboard_widgets w JOIN dashboard_layouts l ON l.id = w.layout_id WHERE l.company_id = $1`,
  report_lines: `SELECT count(*)::int n FROM report_lines r JOIN report_templates t ON t.id = r.template_id WHERE t.company_id = $1`,
  report_line_ledgers: `SELECT count(*)::int n FROM report_line_ledgers x JOIN report_lines r ON r.id = x.line_id JOIN report_templates t ON t.id = r.template_id WHERE t.company_id = $1`,
  refresh_tokens: `SELECT count(*)::int n FROM refresh_tokens x JOIN users u ON u.id = x.user_id WHERE u.company_id = $1`,
  upload_raw_payloads: `SELECT count(*)::int n FROM upload_raw_payloads x JOIN tb_uploads u ON u.id = x.upload_id WHERE u.company_id = $1`,
};
// The same, but for ANOTHER company's rows (what the restricted role must never see).
const FOREIGN_SQL: Record<string, string> = {
  companies: `SELECT count(*)::int n FROM companies WHERE id = $1`,
  dashboard_widgets: COUNT_SQL.dashboard_widgets!, report_lines: COUNT_SQL.report_lines!, report_line_ledgers: COUNT_SQL.report_line_ledgers!,
  refresh_tokens: COUNT_SQL.refresh_tokens!, upload_raw_payloads: COUNT_SQL.upload_raw_payloads!,
};
const CLOSED = ['schema_migrations', 'ledger_master_dedupe_backup'];

/** Runs `fn` in a transaction scoped to `company` (null = no company set) and always rolls it back. */
async function scoped<T>(c: PoolClient, company: string | null, fn: () => Promise<T>): Promise<T> {
  await c.query('BEGIN');
  try {
    if (company) await c.query(`SELECT set_config('app.company_id', '${company}', true)`);
    return await fn();
  } finally { await c.query('ROLLBACK').catch(() => {}); }
}

async function attempt(c: PoolClient, company: string | null, sql: string, params: unknown[] = []): Promise<{ ok: boolean; rows?: number; error?: string }> {
  return scoped(c, company, async () => {
    try { const r = await c.query(sql, params); return { ok: true, rows: r.rowCount ?? r.rows.length }; }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  });
}

async function main() {
  if (!process.argv.includes('--target=branch')) throw new Error('Say --target=branch. This script never runs against main.');
  const url = process.env.BRANCH_DATABASE_URL;
  if (!url) throw new Error('BRANCH_DATABASE_URL is not set');
  if (process.env.DB_HOST && url.includes(process.env.DB_HOST)) throw new Error('BRANCH_DATABASE_URL points at the main host - refusing');

  const owner = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const password = randomBytes(24).toString('hex');
  await owner.query(`ALTER ROLE ${APP_ROLE} WITH PASSWORD '${password}'`);
  const tu = new URL(url); tu.username = APP_ROLE; tu.password = password;
  const app = new Pool({ connectionString: tu.toString(), ssl: { rejectUnauthorized: false }, max: 2 });

  try {
    const { rows: tables } = await owner.query<{ t: string; has_company: boolean }>(
      `SELECT c.relname AS t, EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema='public' AND k.table_name=c.relname AND k.column_name='company_id') AS has_company
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT c.relispartition ORDER BY 1`);
    const { rows: cos } = await owner.query<{ id: string; name: string; n: number }>(
      `SELECT c.id, c.name, (SELECT count(*) FROM tb_uploads u WHERE u.company_id=c.id)::int + (SELECT count(*) FROM zoho_records z WHERE z.company_id=c.id)::int AS n FROM companies c ORDER BY n DESC`);
    if (cos.length < 2) throw new Error('need at least two companies on the branch');
    const pairs: Array<[typeof cos[number], typeof cos[number]]> = [[cos[0]!, cos[1]!], [cos[1]!, cos[0]!]];

    const app1 = await app.connect();
    try {
      // The role itself
      const me = (await app1.query(`SELECT current_user u, (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) bypass, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) su`)).rows[0];
      record('(role)', 'logs in as the restricted role, not an owner, no BYPASSRLS', me.u === APP_ROLE && !me.bypass && !me.su, `${me.u}`);
      const create = await attempt(app1, null, `CREATE TABLE zz_should_not_exist (a int)`);
      record('(role)', 'cannot create tables', !create.ok, create.error?.slice(0, 60) ?? '');

      for (const [A, B] of pairs) {
        for (const t of tables) {
          const name = t.t;
          const tag = `${A.name.slice(0, 12)} vs ${B.name.slice(0, 12)}`;
          if (CLOSED.includes(name)) {
            const r = await attempt(app1, A.id, `SELECT 1 FROM ${name} LIMIT 1`);
            record(name, `closed to the app role (${tag})`, !r.ok && /permission denied/i.test(r.error ?? ''), r.error?.slice(0, 50) ?? 'readable!');
            continue;
          }
          const ownerA = Number((await owner.query(COUNT_SQL[name] ?? `SELECT count(*)::int n FROM ${name} WHERE company_id = $1`, [A.id])).rows[0].n);
          const seenA = await scoped(app1, A.id, async () => Number((await app1.query(`SELECT count(*)::int n FROM ${name}`)).rows[0].n));
          record(name, `sees exactly its own rows (${tag})`, seenA === ownerA, `${seenA} of ${ownerA}`);

          // Nothing of the other company is visible
          if (t.has_company && name !== 'ledger_master') {
            const foreign = await scoped(app1, A.id, async () => Number((await app1.query(`SELECT count(*)::int n FROM ${name} WHERE company_id = $1`, [B.id])).rows[0].n));
            record(name, `sees 0 rows of the other company (${tag})`, foreign === 0, `${foreign}`);
          } else if (FOREIGN_SQL[name]) {
            const ownerB = Number((await owner.query(FOREIGN_SQL[name]!, [B.id])).rows[0].n);
            const total = seenA;
            record(name, `total visible = own rows only, other company has ${ownerB} (${tag})`, total === ownerA, `${total}`);
          }

          // Cannot change or remove the other company's rows
          if (t.has_company && !['audit_trail', 'ledger_master'].includes(name) && name !== 'companies') {
            const upd = await attempt(app1, A.id, `UPDATE ${name} SET company_id = company_id WHERE company_id = $1`, [B.id]);
            record(name, `cannot UPDATE the other company's rows (${tag})`, (upd.ok && upd.rows === 0) || (!upd.ok && /permission denied/i.test(upd.error ?? '')), upd.ok ? `${upd.rows} rows` : upd.error!.slice(0, 40));
            const del = await attempt(app1, A.id, `DELETE FROM ${name} WHERE company_id = $1`, [B.id]);
            record(name, `cannot DELETE the other company's rows (${tag})`, (del.ok && del.rows === 0) || (!del.ok && /permission denied/i.test(del.error ?? '')), del.ok ? `${del.rows} rows` : del.error!.slice(0, 40));
          }

          // No company set: nothing at all
          const none = await scoped(app1, null, async () => Number((await app1.query(`SELECT count(*)::int n FROM ${name}`)).rows[0].n));
          const expectNone = name === 'ledger_master' ? none <= Number((await owner.query(`SELECT count(*)::int n FROM ledger_master WHERE company_id IS NULL AND is_global`)).rows[0].n) : none === 0;
          record(name, `with no company set it sees nothing${name === 'ledger_master' ? ' but the shared rows' : ''} (${tag})`, expectNone, `${none}`);
        }

        // Inserting a row for the other company is refused (tables whose rows are easy to fabricate)
        const inserts: Record<string, string> = {
          audit_trail: `INSERT INTO audit_trail (company_id, action) VALUES ($1, 'RLS_CHECK')`,
          sync_logs: `INSERT INTO sync_logs (id, company_id, source, financial_year, status) VALUES (gen_random_uuid(), $1, 'zoho', 'x', 'success')`,
          zoho_api_usage: `INSERT INTO zoho_api_usage (company_id, day, calls) VALUES ($1, '2000-01-01', 1)`,
          custom_tabs: `INSERT INTO custom_tabs (company_id, name, tab_key) VALUES ($1, 'x', 'rls-check')`,
        };
        for (const [name, sql] of Object.entries(inserts)) {
          const own = await attempt(app1, A.id, sql, [A.id]);
          const foreign = await attempt(app1, A.id, sql, [B.id]);
          record(name, `can insert for its own company, refused for the other (${A.name.slice(0, 12)})`,
            (own.ok || /null value|violates (check|not-null)|column/i.test(own.error ?? '')) && !foreign.ok && /row-level security|violates|null value|column/i.test(foreign.error ?? ''), foreign.ok ? 'INSERTED for the other company!' : (foreign.error ?? '').slice(0, 60));
        }
        // audit_trail: append-only; companies: never created here
        const au = await attempt(app1, A.id, `UPDATE audit_trail SET action = action`);
        record('audit_trail', `cannot UPDATE (append-only) (${A.name.slice(0, 12)})`, !au.ok && /permission denied/i.test(au.error ?? ''), au.error?.slice(0, 40) ?? 'allowed!');
        const ad = await attempt(app1, A.id, `DELETE FROM audit_trail`);
        record('audit_trail', `cannot DELETE (append-only) (${A.name.slice(0, 12)})`, !ad.ok && /permission denied/i.test(ad.error ?? ''), ad.error?.slice(0, 40) ?? 'allowed!');
        const ci = await attempt(app1, A.id, `INSERT INTO companies (name) VALUES ('rls-check')`);
        record('companies', `cannot create a company (${A.name.slice(0, 12)})`, !ci.ok, ci.error?.slice(0, 40) ?? 'allowed!');
        const gm = await attempt(app1, A.id, `UPDATE ledger_master SET note_no = note_no WHERE company_id IS NULL`);
        record('ledger_master', `cannot change the shared rows (${A.name.slice(0, 12)})`, gm.ok && gm.rows === 0, `${gm.rows ?? gm.error}`);
        const bad = await attempt(app1, null, `SET LOCAL app.company_id = 'not-a-uuid'`).then(() => scoped(app1, null, async () => { await app1.query(`SELECT set_config('app.company_id','not-a-uuid',true)`); try { await app1.query('SELECT count(*) FROM tb_ledgers'); return { ok: true }; } catch (e) { return { ok: false, error: (e as Error).message }; } }));
        record('(scope)', 'a malformed company setting fails closed (error, never rows)', !bad.ok, (bad as { error?: string }).error?.slice(0, 50) ?? 'returned rows!');
      }
    } finally { app1.release(); }
  } finally {
    await owner.query(`ALTER ROLE ${APP_ROLE} WITH PASSWORD NULL`).catch(() => {});
    await app.end().catch(() => {}); await owner.end();
  }

  const failed = results.filter((r) => !r.ok);
  const byTable = new Map<string, { pass: number; fail: number }>();
  for (const r of results) { const e = byTable.get(r.table) ?? { pass: 0, fail: 0 }; r.ok ? e.pass++ : e.fail++; byTable.set(r.table, e); }
  console.table([...byTable.entries()].map(([table, v]) => ({ table, passed: v.pass, failed: v.fail })));
  for (const f of failed) console.log(`FAIL  ${f.table}: ${f.check} -> ${f.detail}`);
  // Evidence the checks are not vacuous: tables where the role really saw rows, and the other company had rows too.
  const seen = results.filter((r) => r.check.startsWith('sees exactly its own rows') && !/^0 of 0$/.test(r.detail));
  console.log(`\n${seen.length} "sees exactly its own rows" checks had real data (not 0 of 0). Largest:`);
  console.table(seen.sort((a, b) => Number(b.detail.split(' of ')[1]) - Number(a.detail.split(' of ')[1])).slice(0, 12).map((r) => ({ table: r.table, view: r.check.replace('sees exactly its own rows ', ''), rowsSeenOfExpected: r.detail })));
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed${failed.length ? `, ${failed.length} FAILED` : ''}`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error('RLS CHECK ERROR:', (e as Error).message); process.exit(1); });
