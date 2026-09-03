import 'dotenv/config';
import { Pool } from 'pg';
const pool = new Pool({
  host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});
const companyId = '1abb21f3-efc2-4772-bed7-899ca448e9f9';
const fyId = 'ddf3e124-1049-4d2c-b856-9a70f6a9f9a7';
const { rows } = await pool.query(`SELECT raw_zoho_months FROM tb_uploads WHERE company_id=$1 AND financial_year_id=$2 AND is_current=TRUE`, [companyId, fyId]);
const months = rows[0]?.raw_zoho_months || [];
const marBs = months.find(m => m.month === 'BS Mar');
const halves = marBs.raw_response?.balance_sheet || [];
for (const h of halves) {
  console.log(h.name, '-> total:', h.total, '| total_sub_account:', h.total_sub_account);
}
await pool.end();
