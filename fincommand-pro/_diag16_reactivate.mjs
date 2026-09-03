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
  const { rows } = await client.query(`SELECT refresh_token FROM zoho_config WHERE company_id=$1`, [companyId]);
  const r = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
    params: { refresh_token: rows[0].refresh_token, client_id: process.env.ZOHO_CLIENT_ID, client_secret: process.env.ZOHO_CLIENT_SECRET, grant_type: 'refresh_token' },
  });
  const { access_token, expires_in } = r.data;
  const expiry = new Date(Date.now() + (expires_in - 60) * 1000);
  await client.query(
    `UPDATE zoho_config SET is_active=TRUE, access_token=$1, token_expiry=$2, last_sync_status='never', last_sync_error=NULL, updated_at=NOW() WHERE company_id=$3`,
    [access_token, expiry, companyId]
  );
  console.log('Reactivated. New token expiry:', expiry);
} finally {
  client.release();
  await pool.end();
}
