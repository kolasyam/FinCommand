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

const namesToTrace = ['Tax Payable', 'Professional Tax Payable', '194I_rent TDS Payable', 'TDS on Professional Fees', 'Advance to Arun Baikan', 'Input CGST', 'WIP Asset', 'RealWare', 'Realcollab'];

function walk(arr, parentGroupName, out) {
  if (!Array.isArray(arr)) return;
  for (const item of arr) {
    if (!item) continue;
    const name = String(item.name || item.account_name || '').trim();
    const nested = item.account_transactions;
    if (namesToTrace.some(n => name === n)) {
      out.push({ name, group: parentGroupName, total: item.total, depth: item.depth });
    }
    if (Array.isArray(nested) && nested.length) walk(nested, name || parentGroupName, out);
  }
}

for (const m of months) {
  if (!m.month?.startsWith('BS') && !m.month?.startsWith('P&L')) continue;
  const found = [];
  if (m.month.startsWith('BS')) {
    walk(m.raw_response?.balance_sheet, null, found);
  } else {
    walk(m.raw_response?.profit_and_loss, null, found);
  }
  if (found.length) console.log(m.month, '->', found);
}
await pool.end();
