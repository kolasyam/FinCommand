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
  async function fetchTB(from_date, to_date) {
    const res = await axios.get(`${apiBase}/reports/trialbalance`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: { organization_id: cfg.org_id, from_date, to_date },
      timeout: 20000,
    });
    return res.data;
  }
  function extractSales(data) {
    const tb = data.trialbalance?.[0];
    let found = null;
    function walk(arr) { if (!Array.isArray(arr)) return; for (const item of arr) { if (!item) continue; if (item.name === 'Sales') found = item; if (Array.isArray(item.account_transactions)) walk(item.account_transactions); } }
    walk(tb?.account_transactions);
    return found;
  }

  console.log('=== A) Proper window: from=2025-04-01 to=2025-04-30 ===');
  const a = await fetchTB('2025-04-01', '2025-04-30');
  console.log('Sales:', JSON.stringify(extractSales(a)?.values?.[0]));

  console.log('\n=== B) Degenerate: from=2025-04-30 to=2025-04-30 (same date) ===');
  const b = await fetchTB('2025-04-30', '2025-04-30');
  console.log('Sales:', JSON.stringify(extractSales(b)?.values?.[0]));

  console.log('\n=== C) Opening: from=2025-03-31 to=2025-03-31 (day before FY start) ===');
  const c = await fetchTB('2025-03-31', '2025-03-31');
  console.log('Sales:', JSON.stringify(extractSales(c)?.values?.[0]));
  console.log('Full account list length for C:', (function(){let n=0; function walk(arr){if(!Array.isArray(arr))return;for(const it of arr){if(!it)continue;if(it.account_id)n++;if(Array.isArray(it.account_transactions))walk(it.account_transactions);}} walk(c.trialbalance?.[0]?.account_transactions); return n;})());

  console.log('\n=== D) Very early: from=2000-01-01 to=2000-01-01 ===');
  const d = await fetchTB('2000-01-01', '2000-01-01');
  console.log('Sales:', JSON.stringify(extractSales(d)?.values?.[0]));
  console.log('code/message:', d.code, d.message);
  console.log('Full account list length for D:', (function(){let n=0; function walk(arr){if(!Array.isArray(arr))return;for(const it of arr){if(!it)continue;if(it.account_id)n++;if(Array.isArray(it.account_transactions))walk(it.account_transactions);}} walk(d.trialbalance?.[0]?.account_transactions); return n;})());

  console.log('\n=== E) Far future: from=2026-03-31 to=2026-03-31 ===');
  const e = await fetchTB('2026-03-31', '2026-03-31');
  console.log('Sales:', JSON.stringify(extractSales(e)?.values?.[0]));
} finally {
  client.release();
  await pool.end();
}
