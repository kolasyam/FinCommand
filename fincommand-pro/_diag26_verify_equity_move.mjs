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

function walkFull(arr, path, out) {
  if (!Array.isArray(arr)) return;
  for (const item of arr) {
    if (!item) continue;
    const name = String(item.name || item.account_name || '').trim();
    const nested = item.account_transactions;
    const hasChildren = Array.isArray(nested) && nested.length > 0;
    const newPath = [...path, name];
    if (item.account_id && !hasChildren) {
      out.push({ name, total: item.total, path: newPath.join(' > ') });
    }
    if (hasChildren) walkFull(nested, newPath, out);
  }
}
const all = [];
walkFull(marBs.raw_response?.balance_sheet, [], all);

// Show full path for our 4 suspects + a few known "Share Capital"-suffixed ones for comparison
const namesToCheck = ['Madhu Mohan Katikineni', 'Shailendera Nath', 'Arise Venture Pte Ltd', 'Share Application Money (rights Issue)', 'Ajaygupta Share Capital', 'Amit Midha  Share Capital', 'Retained Earnings', 'Securities Premium A/C'];
for (const n of namesToCheck) {
  const found = all.filter(x => x.name === n);
  console.log(n, '->', found);
}

// Also dump the TOP-LEVEL structure (first 2 levels) of the balance_sheet to see real headings
console.log('\n--- Top-level BS structure ---');
function topLevels(arr, depth, maxDepth) {
  if (!Array.isArray(arr) || depth > maxDepth) return;
  for (const item of arr) {
    if (!item) continue;
    const name = String(item.name || item.account_name || '').trim();
    console.log('  '.repeat(depth) + name);
    if (Array.isArray(item.account_transactions)) topLevels(item.account_transactions, depth + 1, maxDepth);
  }
}
topLevels(marBs.raw_response?.balance_sheet, 0, 2);

await pool.end();
