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
  const { rows } = await client.query(`SELECT * FROM tb_ledgers WHERE upload_id=$1`, [uploadId]);
  console.log('Ledger rows:', rows.length);

  function n(v) { return parseFloat(v) || 0; }
  function closingAnnual(r) {
    const opNet = r.normal_bal === 'Dr' ? (n(r.op_dr) - n(r.op_cr)) : (n(r.op_cr) - n(r.op_dr));
    let mNet = 0;
    for (let m = 1; m <= 12; m++) {
      const dr = n(r[`m${m}_dr`]), cr = n(r[`m${m}_cr`]);
      mNet += r.normal_bal === 'Dr' ? (dr - cr) : (cr - dr);
    }
    return opNet + mNet;
  }

  const bsSections = ['anc','ac','eq','lnc','lc'];
  const totals = {};
  bsSections.forEach(s => totals[s] = 0);
  const bySectionNote = {};
  rows.forEach(r => {
    if (!bsSections.includes(r.section)) return;
    const cb = closingAnnual(r);
    totals[r.section] += cb;
    const key = `${r.section}_${r.note_no}_${r.note_name}`;
    bySectionNote[key] = (bySectionNote[key]||0) + cb;
  });

  console.log('\nBS totals by section (annual closing):');
  Object.entries(totals).forEach(([k,v]) => console.log(' ', k, '=', v.toFixed(2)));

  const totalAssets = totals.anc + totals.ac;
  const totalEL = totals.eq + totals.lnc + totals.lc;
  console.log('\nTotal Assets =', totalAssets.toFixed(2));
  console.log('Total Equity+Liabilities =', totalEL.toFixed(2));
  console.log('Difference =', (totalEL - totalAssets).toFixed(2));
  console.log('Balanced (<1)?', Math.abs(totalEL - totalAssets) < 1);

  console.log('\n--- BS notes detail ---');
  Object.entries(bySectionNote).sort().forEach(([k,v]) => console.log(k, '=', v.toFixed(2)));

  // Unclassified / non-BS-non-PL rows (section null)
  const noSection = rows.filter(r => !r.section);
  console.log('\nRows with NULL section:', noSection.length);
  noSection.forEach(r => console.log(' -', r.ledger_name, r.zoho_account_type));
} finally {
  client.release();
  await pool.end();
}
