import 'dotenv/config';
import pg from 'pg';
import axios from 'axios';
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});
const client = await pool.connect();
const companyId = '1abb21f3-efc2-4772-bed7-899ca448e9f9';
try {
  const { rows } = await client.query(`SELECT * FROM zoho_config WHERE company_id=$1`, [companyId]);
  const cfg = rows[0];
  let token = cfg.access_token;
  if (new Date(cfg.token_expiry) <= new Date()) {
    const res = await axios.post(`https://accounts.zoho.in/oauth/v2/token`, null, {
      params: { refresh_token: cfg.refresh_token, client_id: process.env.ZOHO_CLIENT_ID, client_secret: process.env.ZOHO_CLIENT_SECRET, grant_type: 'refresh_token' },
    });
    token = res.data.access_token;
  }
  const apiBase = 'https://www.zohoapis.in/books/v3';
  async function fetchBS(to_date) {
    const res = await axios.get(`${apiBase}/reports/balancesheet`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: { organization_id: cfg.org_id, to_date },
      timeout: 20000,
    });
    return res.data;
  }
  function findAccount(bs, name) {
    let found = null;
    function walk(arr) { if (!Array.isArray(arr)) return; for (const it of arr) { if (!it) continue; if (it.name === name) found = it; if (Array.isArray(it.account_transactions)) walk(it.account_transactions); } }
    walk(bs);
    return found;
  }

  const apr = await fetchBS('2025-04-30');
  const nov = await fetchBS('2025-11-30');
  const mar = await fetchBS('2026-03-31');

  for (const name of ['Accounts Receivable', 'Ajaygupta Share Capital', 'HDFC Bank - Current Account']) {
    console.log(`\n"${name}":`);
    console.log('  Apr30:', JSON.stringify(findAccount(apr.balance_sheet, name)?.total));
    console.log('  Nov30:', JSON.stringify(findAccount(nov.balance_sheet, name)?.total));
    console.log('  Mar31(2026):', JSON.stringify(findAccount(mar.balance_sheet, name)?.total));
  }

  // Also print overall total assets figure if present at top level
  console.log('\nTop-level BS total (Apr):', apr.balance_sheet?.[apr.balance_sheet.length-1]?.total, apr.balance_sheet?.map(s=>({name:s.name,total:s.total})));
} finally {
  client.release();
  await pool.end();
}
