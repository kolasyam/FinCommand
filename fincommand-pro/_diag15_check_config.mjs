import 'dotenv/config';
import pg from 'pg';
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});
const client = await pool.connect();
try {
  const { rows } = await client.query(
    `SELECT company_id, org_id, is_active, refresh_token IS NOT NULL AS has_refresh, token_expiry,
            last_sync_status, last_sync_error, updated_at
     FROM zoho_config WHERE company_id='1abb21f3-efc2-4772-bed7-899ca448e9f9'`
  );
  console.log(rows);
} finally {
  client.release();
  await pool.end();
}
