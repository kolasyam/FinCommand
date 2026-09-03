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

  // Refresh if expired
  if (new Date(cfg.token_expiry) <= new Date()) {
    const base = 'https://accounts.zoho.in';
    const res = await axios.post(`${base}/oauth/v2/token`, null, {
      params: {
        refresh_token: cfg.refresh_token,
        client_id: process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        grant_type: 'refresh_token',
      },
    });
    token = res.data.access_token;
    console.log('Refreshed token');
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

  console.log('=== Fetching April 2025 (2025-04-01 to 2025-04-30) ===');
  const apr = await fetchTB('2025-04-01', '2025-04-30');
  console.log('code:', apr.code, apr.message);

  console.log('\n=== Fetching November 2025 (2025-11-01 to 2025-11-30) ===');
  const nov = await fetchTB('2025-11-01', '2025-11-30');
  console.log('code:', nov.code, nov.message);

  function extractSales(data) {
    const tb = data.trialbalance?.[0];
    let found = null;
    function walk(arr) {
      if (!Array.isArray(arr)) return;
      for (const item of arr) {
        if (!item) continue;
        if (item.name === 'Sales') found = item;
        if (Array.isArray(item.account_transactions)) walk(item.account_transactions);
      }
    }
    walk(tb?.account_transactions);
    return found;
  }

  const aprSales = extractSales(apr);
  const novSales = extractSales(nov);
  console.log('\nApril "Sales" raw item:', JSON.stringify(aprSales, null, 2));
  console.log('\nNovember "Sales" raw item:', JSON.stringify(novSales, null, 2));

  // Also compare full JSON strings to check if entire responses are byte-identical
  console.log('\nFull responses identical?', JSON.stringify(apr) === JSON.stringify(nov));
} finally {
  client.release();
  await pool.end();
}
