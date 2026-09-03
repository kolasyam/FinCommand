import 'dotenv/config';
import { Pool } from 'pg';
const pool = new Pool({
  host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const companyId = '1abb21f3-efc2-4772-bed7-899ca448e9f9';

const { rows: fys } = await pool.query(`SELECT * FROM financial_years WHERE company_id=$1 ORDER BY start_date DESC`, [companyId]);
console.log('=== Financial Years ===');
console.log(fys.map(f => ({ id: f.id, label: f.label, start: f.start_date, end: f.end_date, locked: f.is_locked })));

const { rows: users } = await pool.query(`SELECT id, name, email, role FROM users WHERE company_id=$1`, [companyId]);
console.log('\n=== Users ===');
console.log(users);

const fyId = fys[0]?.id;
if (fyId) {
  const { rows: ledgers } = await pool.query(`
    SELECT l.ledger_name, l.section, l.note_no, l.note_name, l.normal_bal, l.op_dr, l.op_cr,
           l.m1_dr,l.m1_cr,l.m2_dr,l.m2_cr,l.m3_dr,l.m3_cr,l.m4_dr,l.m4_cr,l.m5_dr,l.m5_cr,l.m6_dr,l.m6_cr,
           l.m7_dr,l.m7_cr,l.m8_dr,l.m8_cr,l.m9_dr,l.m9_cr,l.m10_dr,l.m10_cr,l.m11_dr,l.m11_cr,l.m12_dr,l.m12_cr
    FROM tb_ledgers l JOIN tb_uploads u ON u.id=l.upload_id
    WHERE l.company_id=$1 AND l.financial_year_id=$2 AND u.is_current=TRUE
    ORDER BY l.section, l.note_no, l.ledger_name
  `, [companyId, fyId]);
  console.log(`\n=== tb_ledgers for FY ${fys[0].label} (${ledgers.length} rows) ===`);
  for (const l of ledgers) {
    const annualDr = ['m1','m2','m3','m4','m5','m6','m7','m8','m9','m10','m11','m12'].reduce((s,m)=>s+parseFloat(l[m+'_dr']||0),0);
    const annualCr = ['m1','m2','m3','m4','m5','m6','m7','m8','m9','m10','m11','m12'].reduce((s,m)=>s+parseFloat(l[m+'_cr']||0),0);
    console.log(`  [${l.section}/${l.note_no} ${l.note_name}] ${l.ledger_name} | normal=${l.normal_bal} | op_dr=${l.op_dr} op_cr=${l.op_cr} | annual_dr=${annualDr.toFixed(2)} annual_cr=${annualCr.toFixed(2)}`);
  }
}
await pool.end();
