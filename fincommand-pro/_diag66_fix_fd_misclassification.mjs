import 'dotenv/config';
import { Pool } from 'pg';
const pool = new Pool({
  host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});
const companyId = '1abb21f3-efc2-4772-bed7-899ca448e9f9';
const ledgerCode = '1816131000000029062'; // "Fixed Deposit- Axis Bank"

console.log('=== BEFORE ===');
const before = await pool.query(
  `SELECT id, financial_year_id, ledger_name, note_no, note_name, treasury_type FROM tb_ledgers
   WHERE company_id=$1 AND ledger_code=$2`, [companyId, ledgerCode]
);
console.log(before.rows);

console.log('\n=== Fixing ledger_master (sticky mapping, so future syncs stay correct) ===');
const lmRes = await pool.query(
  `UPDATE ledger_master SET treasury_type='fd', note_no=20, note_name='Bank Balances (FDs)', updated_at=NOW()
   WHERE company_id=$1 AND ledger_code=$2 RETURNING id, ledger_name`, [companyId, ledgerCode]
);
console.log(`Updated ${lmRes.rowCount} ledger_master row(s):`, lmRes.rows);

console.log('\n=== Fixing tb_ledgers (already-synced data for both FYs) ===');
const tbRes = await pool.query(
  `UPDATE tb_ledgers SET treasury_type='fd', note_no=20, note_name='Bank Balances (FDs)'
   WHERE company_id=$1 AND ledger_code=$2 RETURNING id, financial_year_id, ledger_name`, [companyId, ledgerCode]
);
console.log(`Updated ${tbRes.rowCount} tb_ledgers row(s):`, tbRes.rows);

console.log('\n=== AFTER ===');
const after = await pool.query(
  `SELECT id, financial_year_id, ledger_name, note_no, note_name, treasury_type FROM tb_ledgers
   WHERE company_id=$1 AND ledger_code=$2`, [companyId, ledgerCode]
);
console.log(after.rows);

await pool.end();
