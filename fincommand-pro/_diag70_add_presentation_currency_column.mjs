import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function main() {
  await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS presentation_currency CHAR(3);`);
  const { rows } = await pool.query(`SELECT id, name, currency, presentation_currency FROM companies;`);
  console.log('companies table now has presentation_currency. Current rows:');
  console.table(rows);
  await pool.end();
}
main().catch(e => { console.error('FAILED:', e); process.exit(1); });
