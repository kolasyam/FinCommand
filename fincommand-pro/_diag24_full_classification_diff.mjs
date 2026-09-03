import 'dotenv/config';
import { Pool } from 'pg';
const pool = new Pool({
  host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});
const companyId = '1abb21f3-efc2-4772-bed7-899ca448e9f9';
const fyId = 'ddf3e124-1049-4d2c-b856-9a70f6a9f9a7';

const { rows: uploadRows } = await pool.query(`SELECT raw_zoho_months FROM tb_uploads WHERE company_id=$1 AND financial_year_id=$2 AND is_current=TRUE`, [companyId, fyId]);
const months = uploadRows[0]?.raw_zoho_months || [];
const marBs = months.find(m => m.month === 'BS Mar');
const marPl = months.find(m => m.month === 'P&L Mar');

function walk(arr, parentGroupName, out) {
  if (!Array.isArray(arr)) return;
  for (const item of arr) {
    if (!item) continue;
    const name = String(item.name || item.account_name || '').trim();
    const nested = item.account_transactions;
    const hasChildren = Array.isArray(nested) && nested.length > 0;
    if (!hasChildren && name && item.account_id) {
      out.push({ name, zoho_group: parentGroupName });
    }
    if (hasChildren) walk(nested, name || parentGroupName, out);
  }
}

const zohoBsLeaves = [];
walk(marBs.raw_response?.balance_sheet, null, zohoBsLeaves);
const zohoPlLeaves = [];
walk(marPl.raw_response?.profit_and_loss, null, zohoPlLeaves);

const zohoGroupOf = new Map();
zohoBsLeaves.forEach(l => zohoGroupOf.set(l.name, { side: 'BS', group: l.zoho_group }));
zohoPlLeaves.forEach(l => zohoGroupOf.set(l.name, { side: 'PL', group: l.zoho_group }));

// Expected mapping: our section/note_no should roughly correspond to zoho group
function expectedSection(zohoGroup, side) {
  if (!zohoGroup) return null;
  const g = zohoGroup.toLowerCase();
  if (side === 'PL') {
    if (g.includes('income')) return 'inc';
    if (g.includes('cost of goods')) return 'exp';
    return 'exp';
  }
  if (g.includes('current liabilit')) return 'lc';
  if (g.includes('long-term liabilit') || g.includes('non-current liabilit') || g.includes('long term liabilit')) return 'lnc';
  if (g.includes('fixed asset')) return 'anc';
  if (g.includes('other current asset')) return 'ac';
  if (g.includes('current asset')) return 'ac';
  if (g.includes('bank') || g.includes('cash')) return 'ac';
  if (g.includes('equity')) return 'eq';
  return null;
}

const { rows: ledgers } = await pool.query(`
  SELECT l.ledger_name, l.section, l.note_no, l.note_name
  FROM tb_ledgers l JOIN tb_uploads u ON u.id=l.upload_id
  WHERE l.company_id=$1 AND l.financial_year_id=$2 AND u.is_current=TRUE
`, [companyId, fyId]);

const mismatches = [];
for (const l of ledgers) {
  const z = zohoGroupOf.get(l.ledger_name);
  if (!z) continue; // not seen in this month's snapshot (zero balance that month) - skip
  const expected = expectedSection(z.group, z.side);
  if (!expected) continue;
  if (expected !== l.section) {
    mismatches.push({ ledger: l.ledger_name, zoho_side: z.side, zoho_group: z.group, our_section: l.section, our_note: `${l.note_no} ${l.note_name}`, expected_section: expected });
  }
}
console.log(`Total ledgers checked against Mar snapshot: ${ledgers.length}, matched in Zoho snapshot: ${[...zohoGroupOf.keys()].length}`);
console.log(`MISMATCHES FOUND: ${mismatches.length}`);
console.log(JSON.stringify(mismatches, null, 2));
await pool.end();
