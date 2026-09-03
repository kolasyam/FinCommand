import 'dotenv/config';
import pg from 'pg';
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});
const client = await pool.connect();
const companyId = '1abb21f3-efc2-4772-bed7-899ca448e9f9';
try {
  const { rows: up } = await client.query(`SELECT id FROM tb_uploads WHERE company_id=$1 AND is_current=TRUE`, [companyId]);
  const uploadId = up[0].id;

  const { rows } = await client.query(
    `SELECT ledger_name, section, note_no, normal_bal, op_dr, op_cr,
            m1_dr,m1_cr,m2_dr,m2_cr,m3_dr,m3_cr,m4_dr,m4_cr,m5_dr,m5_cr,m6_dr,m6_cr,
            m7_dr,m7_cr,m8_dr,m8_cr,m9_dr,m9_cr,m10_dr,m10_cr,m11_dr,m11_cr,m12_dr,m12_cr
     FROM tb_ledgers WHERE upload_id=$1 AND ledger_name ILIKE ANY($2)`,
    [uploadId, ['%share capital%', '%retained%', '%accounts receivable%', 'Sales', '%accrued interest%']]
  );

  function n(v){ return parseFloat(v)||0; }
  const months = ['Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar'];
  rows.forEach(r => {
    console.log(`\n${r.ledger_name} | section=${r.section} note=${r.note_no} normal_bal=${r.normal_bal} op_dr=${r.op_dr} op_cr=${r.op_cr}`);
    for (let m=1;m<=12;m++){
      const dr = n(r[`m${m}_dr`]), cr = n(r[`m${m}_cr`]);
      if (dr!==0 || cr!==0) console.log(`  ${months[m-1]}: dr=${dr} cr=${cr}`);
    }
  });

  // Also: total op_dr/op_cr across ALL ledgers
  const { rows: allRows } = await client.query(`SELECT op_dr, op_cr FROM tb_ledgers WHERE upload_id=$1`, [uploadId]);
  const totalOpDr = allRows.reduce((s,r)=>s+n(r.op_dr),0);
  const totalOpCr = allRows.reduce((s,r)=>s+n(r.op_cr),0);
  const nonZeroOp = allRows.filter(r => n(r.op_dr)!==0 || n(r.op_cr)!==0).length;
  console.log('\n\nTotal op_dr across all ledgers:', totalOpDr, ' Total op_cr:', totalOpCr, ' Non-zero-opening ledger count:', nonZeroOp, '/', allRows.length);
} finally {
  client.release();
  await pool.end();
}
