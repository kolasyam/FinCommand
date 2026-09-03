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

  async function fetchPL(from_date, to_date) {
    const res = await axios.get(`${apiBase}/reports/profitandloss`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: { organization_id: cfg.org_id, from_date, to_date },
      timeout: 20000,
    });
    return res.data;
  }
  async function fetchBS(to_date) {
    const res = await axios.get(`${apiBase}/reports/balancesheet`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: { organization_id: cfg.org_id, to_date },
      timeout: 20000,
    });
    return res.data;
  }

  console.log('=== P&L April 2025 (2025-04-01 to 2025-04-30) ===');
  const plApr = await fetchPL('2025-04-01', '2025-04-30');
  console.log('code:', plApr.code, plApr.message);
  console.log(JSON.stringify(plApr.profit_and_loss || plApr, null, 2).slice(0, 3000));

  console.log('\n\n=== P&L November 2025 (2025-11-01 to 2025-11-30) ===');
  const plNov = await fetchPL('2025-11-01', '2025-11-30');
  console.log('code:', plNov.code, plNov.message);
  console.log(JSON.stringify(plNov.profit_and_loss || plNov, null, 2).slice(0, 3000));

  console.log('\n\n=== Balance Sheet as of 2025-04-30 ===');
  const bsApr = await fetchBS('2025-04-30');
  console.log('code:', bsApr.code, bsApr.message);
  console.log('top keys:', Object.keys(bsApr));

  console.log('\n\n=== Balance Sheet as of 2025-11-30 ===');
  const bsNov = await fetchBS('2025-11-30');
  console.log('code:', bsNov.code, bsNov.message);
} finally {
  client.release();
  await pool.end();
}
