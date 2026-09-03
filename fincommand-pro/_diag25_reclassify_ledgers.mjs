// Re-classifies every ledger in the current Zoho-sourced upload using the
// FIXED classifyZohoLedger()/classifyHint() logic (see lib/services/zoho.ts)
// against the real category_hint captured from the raw Zoho P&L/BS
// snapshots already stored in tb_uploads.raw_zoho_months — then patches
// tb_ledgers' classification columns (note_no/note_name/section/
// treasury_type/normal_bal/zoho_account_type) and the matching per-company
// ledger_master row wherever the corrected classification differs from
// what's currently stored. Does NOT touch any numeric Dr/Cr/opening amount
// — those were already correct; only their categorization was wrong.
import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// ── Mirrors the FIXED lib/services/zoho.ts exactly ──
const ZOHO_TYPE_MAP = {
  cash: { note_no: 19, note_name: 'Cash and Cash Equivalents', section: 'ac', normal_bal: 'Dr', treasury_type: 'cash' },
  petty_cash: { note_no: 19, note_name: 'Cash and Cash Equivalents', section: 'ac', normal_bal: 'Dr', treasury_type: 'cash' },
  bank: { note_no: 19, note_name: 'Cash and Cash Equivalents', section: 'ac', normal_bal: 'Dr', treasury_type: 'bank_ca' },
  bank_account: { note_no: 19, note_name: 'Cash and Cash Equivalents', section: 'ac', normal_bal: 'Dr', treasury_type: 'bank_ca' },
  accounts_receivable: { note_no: 16, note_name: 'Trade Receivables', section: 'ac', normal_bal: 'Dr' },
  receivable: { note_no: 16, note_name: 'Trade Receivables', section: 'ac', normal_bal: 'Dr' },
  inventory: { note_no: 15, note_name: 'Inventories', section: 'ac', normal_bal: 'Dr' },
  stock: { note_no: 15, note_name: 'Inventories', section: 'ac', normal_bal: 'Dr' },
  other_asset: { note_no: 23, note_name: 'Other Current Assets', section: 'ac', normal_bal: 'Dr' },
  other_current_asset: { note_no: 23, note_name: 'Other Current Assets', section: 'ac', normal_bal: 'Dr' },
  fixed_asset: { note_no: 10, note_name: 'Property, Plant and Equipment', section: 'anc', normal_bal: 'Dr' },
  asset: { note_no: 23, note_name: 'Other Current Assets', section: 'ac', normal_bal: 'Dr' }, // FIXED (was PPE)
  other_non_current_asset: { note_no: 14, note_name: 'Other Non-Current Assets', section: 'anc', normal_bal: 'Dr' },
  accounts_payable: { note_no: 7, note_name: 'Trade Payables', section: 'lc', normal_bal: 'Cr' },
  payable: { note_no: 7, note_name: 'Trade Payables', section: 'lc', normal_bal: 'Cr' },
  short_term_liability: { note_no: 9, note_name: 'Short-Term Borrowings', section: 'lc', normal_bal: 'Cr' },
  other_liability: { note_no: 17, note_name: 'Other Current Liabilities', section: 'lc', normal_bal: 'Cr' },
  other_current_liability: { note_no: 17, note_name: 'Other Current Liabilities', section: 'lc', normal_bal: 'Cr' },
  other_non_current_liability: { note_no: 3, note_name: 'Long-Term Borrowings', section: 'lnc', normal_bal: 'Cr' },
  long_term_liability: { note_no: 3, note_name: 'Long-Term Borrowings', section: 'lnc', normal_bal: 'Cr' },
  equity: { note_no: 1, note_name: 'Share Capital', section: 'eq', normal_bal: 'Cr' },
  equity_share_capital: { note_no: 1, note_name: 'Share Capital', section: 'eq', normal_bal: 'Cr' },
  other_equity: { note_no: 2, note_name: 'Other Equity', section: 'eq', normal_bal: 'Cr' },
  retained_earnings: { note_no: 2, note_name: 'Other Equity', section: 'eq', normal_bal: 'Cr' },
  income: { note_no: 20, note_name: 'Revenue from Operations', section: 'inc', normal_bal: 'Cr' },
  sales: { note_no: 20, note_name: 'Revenue from Operations', section: 'inc', normal_bal: 'Cr' },
  revenue: { note_no: 20, note_name: 'Revenue from Operations', section: 'inc', normal_bal: 'Cr' },
  other_income: { note_no: 21, note_name: 'Other Income', section: 'inc', normal_bal: 'Cr' },
  cost_of_goods_sold: { note_no: 22, note_name: 'Cost of Services', section: 'exp', normal_bal: 'Dr' },
  cogs: { note_no: 22, note_name: 'Cost of Services', section: 'exp', normal_bal: 'Dr' },
  direct_expense: { note_no: 22, note_name: 'Cost of Services', section: 'exp', normal_bal: 'Dr' },
  employee_expense: { note_no: 23, note_name: 'Employee Benefits', section: 'exp', normal_bal: 'Dr' },
  payroll_expense: { note_no: 23, note_name: 'Employee Benefits', section: 'exp', normal_bal: 'Dr' },
  finance_cost: { note_no: 24, note_name: 'Finance Costs', section: 'exp', normal_bal: 'Dr' },
  interest_expense: { note_no: 24, note_name: 'Finance Costs', section: 'exp', normal_bal: 'Dr' },
  depreciation: { note_no: 25, note_name: 'Depreciation & Amort.', section: 'exp', normal_bal: 'Dr' },
  expense: { note_no: 26, note_name: 'Other Expenses', section: 'exp', normal_bal: 'Dr' },
  other_expense: { note_no: 26, note_name: 'Other Expenses', section: 'exp', normal_bal: 'Dr' },
  operating_expense: { note_no: 26, note_name: 'Other Expenses', section: 'exp', normal_bal: 'Dr' },
};

function classifyHint(categoryHint, broadType) {
  if (!categoryHint) return broadType;
  const norm = categoryHint.toLowerCase().trim().replace(/[\s_-]+/g, '_');
  if (norm in ZOHO_TYPE_MAP) return norm;
  const candidates = [
    norm.endsWith('ies') ? `${norm.slice(0, -3)}y` : null,
    norm.endsWith('s') && !norm.endsWith('ss') ? norm.slice(0, -1) : null,
  ];
  for (const c of candidates) {
    if (c && c in ZOHO_TYPE_MAP) return c;
  }
  return broadType;
}

function classifyZohoLedger(nameKey, rawType) {
  const normType = rawType.toLowerCase().replace(/[\s_-]+/g, '_');
  const lowerName = nameKey.toLowerCase().trim();
  let fallback = ZOHO_TYPE_MAP[normType] || ZOHO_TYPE_MAP[rawType.toLowerCase().trim()];

  if (lowerName.includes('share capital') || (lowerName.includes('capital') && !lowerName.includes('work')) || lowerName.includes('securities premium') || lowerName.includes('retained earnings')) {
    return lowerName.includes('premium') || lowerName.includes('earnings') ? ZOHO_TYPE_MAP['other_equity'] : ZOHO_TYPE_MAP['equity_share_capital'];
  }
  if (lowerName.includes('loan') || lowerName.includes('borrowing') || lowerName.includes(' (od)') || lowerName.includes(' overdraft')) {
    return lowerName.includes('long') || lowerName.includes('term loan') ? ZOHO_TYPE_MAP['long_term_liability'] : ZOHO_TYPE_MAP['short_term_liability'];
  }
  if (lowerName.includes('sales') || lowerName.includes('revenue') || lowerName.includes('income from services')) {
    return ZOHO_TYPE_MAP['sales'];
  }
  if (lowerName.includes('interest income') || lowerName.includes('other income') || lowerName.includes('other charges received') || lowerName.includes('dividend')) {
    return ZOHO_TYPE_MAP['other_income'];
  }
  if (lowerName.includes('salary') || lowerName.includes('salaries') || lowerName.includes('wages') || lowerName.includes('payroll') || lowerName.includes('pf ') || lowerName.includes('esic') || lowerName.includes('employee')) {
    if (lowerName.includes('payable') || normType.includes('liability') || normType.includes('payable')) {
      return ZOHO_TYPE_MAP['other_current_liability'];
    }
    return ZOHO_TYPE_MAP['employee_expense'];
  }
  if (lowerName.includes('deprec') || lowerName.includes('amort')) {
    return ZOHO_TYPE_MAP['depreciation'];
  }
  if (
    (lowerName.includes('interest') && (lowerName.includes('exp') || lowerName.includes('paid') || lowerName.includes('charge'))) ||
    lowerName.includes('finance cost') || lowerName.includes('financial cost') ||
    lowerName.includes('financial charge') || lowerName.includes('bank charge') ||
    lowerName.includes('loan processing')
  ) {
    return ZOHO_TYPE_MAP['finance_cost'];
  }
  if (lowerName.includes('accounts payable') || lowerName.includes('trade payable') || lowerName.includes('creditor')) {
    return ZOHO_TYPE_MAP['accounts_payable'];
  }
  if (lowerName.includes('accounts receivable') || lowerName.includes('trade receivable') || lowerName.includes('debtor')) {
    return ZOHO_TYPE_MAP['accounts_receivable'];
  }
  if (lowerName.includes('fixed deposit') || lowerName.includes(' fd')) {
    return ZOHO_TYPE_MAP['bank'];
  }

  if (fallback) return fallback;

  if (normType.includes('income') || normType.includes('sales') || normType.includes('revenue')) return ZOHO_TYPE_MAP['income'];
  if (normType.includes('cogs') || normType.includes('cost')) return ZOHO_TYPE_MAP['cost_of_goods_sold'];
  if (normType.includes('payable')) return ZOHO_TYPE_MAP['accounts_payable'];
  if (normType.includes('liability')) return ZOHO_TYPE_MAP['other_liability'];
  if (normType.includes('receivable')) return ZOHO_TYPE_MAP['accounts_receivable'];
  if (normType.includes('asset')) return lowerName.includes('fixed') ? ZOHO_TYPE_MAP['fixed_asset'] : ZOHO_TYPE_MAP['other_asset'];
  if (normType.includes('equity')) return ZOHO_TYPE_MAP['equity'];
  if (normType.includes('expense') || lowerName.includes('expense') || lowerName.includes('exp') || lowerName.includes('fee') || lowerName.includes('rent') || lowerName.includes('tax')) return ZOHO_TYPE_MAP['expense'];
  if (normType.includes('bank') || normType.includes('cash')) return ZOHO_TYPE_MAP['bank'];

  return ZOHO_TYPE_MAP['expense'];
}

function plBroadType(categoryHint) {
  const h = (categoryHint || '').toLowerCase();
  if (h.includes('cost of goods')) return { isIncome: false, broadType: 'cost_of_goods_sold' };
  if (h.includes('non operating income')) return { isIncome: true, broadType: 'other_income' };
  if (h.includes('income')) return { isIncome: true, broadType: 'income' };
  return { isIncome: false, broadType: 'expense' };
}

function walkLeaves(arr, parentGroupName, out) {
  if (!Array.isArray(arr)) return;
  const isHeaderName = (name) => { const l = name.toLowerCase().trim(); return !l || l === 'total' || l.startsWith('total '); };
  for (const item of arr) {
    if (!item) continue;
    const name = String(item.name || item.account_name || '').trim();
    const nested = item.account_transactions;
    const hasChildren = Array.isArray(nested) && nested.length > 0;
    if (item.account_id && !hasChildren && name && !isHeaderName(name)) {
      out.push({ account_name: name, category_hint: parentGroupName });
    }
    if (hasChildren) walkLeaves(nested, name || parentGroupName, out);
  }
}

async function main() {
  const client = await pool.connect();
  try {
    const { rows: uploads } = await client.query(`
      SELECT id AS upload_id, company_id, financial_year_id, raw_zoho_months
      FROM tb_uploads WHERE source='zoho' AND is_current=TRUE AND raw_zoho_months IS NOT NULL
    `);

    for (const upload of uploads) {
      console.log(`\n=== Upload ${upload.upload_id} ===`);
      const months = upload.raw_zoho_months || [];

      // Collect the most-recently-seen category_hint per ledger name, and
      // whether it came from the P&L (income/expense) or BS (asset/liability)
      // side — mirrors syncFromZoho()'s own extraction exactly.
      const hintByLedger = new Map(); // name -> { side: 'pl'|'bs', hint, isAssetSide? }

      for (const m of months) {
        if (m.month?.startsWith('P&L')) {
          const leaves = [];
          walkLeaves(m.raw_response?.profit_and_loss, null, leaves);
          leaves.forEach(l => hintByLedger.set(l.account_name, { side: 'pl', hint: l.category_hint }));
        } else if (m.month?.startsWith('BS')) {
          const topArray = m.raw_response?.balance_sheet;
          if (Array.isArray(topArray)) {
            topArray.forEach(half => {
              if (!half) return;
              const isAssetSide = String(half.name || '').toLowerCase().includes('asset');
              const leaves = [];
              walkLeaves([half], null, leaves);
              leaves.forEach(l => hintByLedger.set(l.account_name, { side: 'bs', hint: l.category_hint, isAssetSide }));
            });
          }
        }
      }
      console.log(`  Reconstructed category hints for ${hintByLedger.size} ledger names from raw Zoho snapshots`);

      const { rows: ledgers } = await client.query(`
        SELECT id, ledger_name, ledger_code, section, note_no, note_name, treasury_type, normal_bal
        FROM tb_ledgers WHERE upload_id=$1
      `, [upload.upload_id]);

      let changed = 0;
      const changeLog = [];

      await client.query('BEGIN');
      try {
        for (const l of ledgers) {
          const h = hintByLedger.get(l.ledger_name);
          if (!h) continue; // no snapshot data for this ledger name (zero-balance every month) — leave as-is

          const broadType = h.side === 'pl' ? plBroadType(h.hint).broadType : (h.isAssetSide ? 'asset' : 'liability');
          const accountType = classifyHint(h.hint, broadType);
          const corrected = classifyZohoLedger(l.ledger_name, accountType);
          if (!corrected) continue;

          const sameClassification =
            corrected.note_no === l.note_no &&
            corrected.section === l.section &&
            (corrected.treasury_type || null) === (l.treasury_type || null) &&
            corrected.normal_bal === l.normal_bal;

          if (sameClassification) continue;

          changed++;
          changeLog.push({
            ledger: l.ledger_name,
            zoho_group: h.hint,
            before: `${l.section}/${l.note_no} ${l.note_name}`,
            after: `${corrected.section}/${corrected.note_no} ${corrected.note_name}`,
          });

          await client.query(
            `UPDATE tb_ledgers SET note_no=$1, note_name=$2, section=$3, treasury_type=$4, normal_bal=$5, zoho_account_type=$6
             WHERE id=$7`,
            [corrected.note_no, corrected.note_name, corrected.section, corrected.treasury_type || null, corrected.normal_bal, accountType, l.id]
          );

          // Keep the per-company ledger_master row (if any) in sync so future
          // syncs use the corrected mapping instead of re-learning the old one.
          await client.query(
            `UPDATE ledger_master SET note_no=$1, note_name=$2, section=$3, treasury_type=$4, normal_bal=$5, updated_at=NOW()
             WHERE company_id=$6 AND ledger_name=$7`,
            [corrected.note_no, corrected.note_name, corrected.section, corrected.treasury_type || null, corrected.normal_bal, upload.company_id, l.ledger_name]
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        console.error('  ❌ Reclassification failed, rolled back:', e.message);
        continue;
      }

      console.log(`  Reclassified ${changed} ledger(s):`);
      changeLog.forEach(c => console.log(`    - ${c.ledger} [Zoho group: ${c.zoho_group}] : ${c.before}  ->  ${c.after}`));
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main();
