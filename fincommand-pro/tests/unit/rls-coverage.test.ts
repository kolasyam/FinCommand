import fs from 'fs';
import path from 'path';

/**
 * Row-level security must cover EVERY table. The database refuses to apply 0008 if a table is left open, but
 * a table created by a LATER migration would be open to the restricted login by mistake of omission. This
 * reads the migrations and fails until every table they create is covered by a migration that enables
 * row-level security (0008 or later).
 */
const dir = path.join(process.cwd(), 'db', 'migrations');
const files = fs.readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
const sql = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8').replace(/--[^\n]*/g, '');

// The baseline (0000) is a marker: its tables are defined in the frozen db/schema.sql.
const baseline = fs.readFileSync(path.join(process.cwd(), 'db', 'schema.sql'), 'utf8').replace(/--[^\n]*/g, '');
const sources = [baseline, ...files.map(sql)];

const created = new Set<string>();
const dropped = new Set<string>();
for (const text of sources) {
  for (const m of text.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_0-9]+)"?/gi)) created.add(m[1]!.toLowerCase());
  for (const m of text.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?([a-z_0-9]+)"?/gi)) dropped.add(m[1]!.toLowerCase());
}

const covered = new Set<string>();
for (const f of files.filter((x) => Number(x.slice(0, 4)) >= 8)) {
  const text = sql(f);
  if (!/ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(text)) continue;
  for (const m of text.matchAll(/ALTER\s+TABLE\s+(?:public\.)?"?([a-z_0-9]+)"?\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi)) covered.add(m[1]!.toLowerCase());
  for (const arr of text.matchAll(/ARRAY\s*\[([^\]]*)\]/gi)) for (const q of arr[1]!.matchAll(/'([a-z_0-9]+)'/gi)) covered.add(q[1]!.toLowerCase());
}

describe('row-level security coverage', () => {
  test('the migrations create tables, and 0008 exists', () => {
    expect(created.size).toBeGreaterThan(20);
    expect(files.some((f) => f.startsWith('0008_'))).toBe(true);
  });

  test('every table any migration creates is covered by a migration that enables row-level security', () => {
    const open = [...created].filter((t) => !dropped.has(t) && !covered.has(t)).sort();
    expect(open).toEqual([]);
  });

  test('the tenant policies compare against app_company_id() and always carry a WITH CHECK', () => {
    const text = sql(files.find((f) => f.startsWith('0008_'))!);
    expect(text).toMatch(/company_id = app_company_id\(\)/);
    expect(text).toMatch(/WITH CHECK/);
    // a policy that would let every row through (fail open) is never written
    expect(text).not.toMatch(/USING\s*\(\s*true\s*\)/i);
  });

  test('the restricted role is created without BYPASSRLS and without a password in git', () => {
    const text = sql(files.find((f) => f.startsWith('0008_'))!);
    expect(text).toMatch(/CREATE ROLE fincommand_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS/);
    expect(text).not.toMatch(/PASSWORD/i);
  });
});
