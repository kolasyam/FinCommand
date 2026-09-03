/* eslint-disable no-console */
import 'dotenv/config';
import { Pool } from 'pg';
import { computeMIS, type TbLedgerRow, type PeriodParams } from './lib/financial/tb-engine';

const pool = new Pool({
  host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// The 6 ledgers whose P&L-vs-BS classification changed today (exp -> lc)
const REVERT_TO_EXP26 = ['Professional Tax Payable', 'Tax Payable', '194I_rent TDS Payable', 'TDS on Professional Fees'];
const REVERT_TO_EXP23 = ['EPF Employee Contribution', 'PF Employer Contribution'];

async function run(fyId: string, label: string) {
  const companyId = '1abb21f3-efc2-4772-bed7-899ca448e9f9';
  const { rows: current } = await pool.query<TbLedgerRow>(`
    SELECT l.* FROM tb_ledgers l JOIN tb_uploads u ON u.id = l.upload_id
    WHERE l.company_id=$1 AND l.financial_year_id=$2 AND u.is_current=TRUE
  `, [companyId, fyId]);

  const before: TbLedgerRow[] = current.map((l) => {
    if (REVERT_TO_EXP26.includes(l.ledger_name)) {
      return { ...l, section: 'exp', note_no: 26, note_name: 'Other Expenses' };
    }
    if (REVERT_TO_EXP23.includes(l.ledger_name)) {
      return { ...l, section: 'exp', note_no: 23, note_name: 'Employee Benefits' };
    }
    return l;
  });

  const params: PeriodParams = { periodType: 'annual', period: null, yearType: 'FY' };
  const misBefore = computeMIS(before, params);
  const misAfter = computeMIS(current, params);

  const row = (l: string, b: number, a: number) => console.log(`${l.padEnd(16)} before: ${b.toLocaleString('en-IN').padStart(14)}   after: ${a.toLocaleString('en-IN').padStart(14)}   delta: ${(a - b).toLocaleString('en-IN')}`);

  console.log(`\n=== ${label} ===`);
  row('Revenue', misBefore.totals.rev, misAfter.totals.rev);
  row('Employee Cost', misBefore.totals.emp, misAfter.totals.emp);
  row('Other Expenses', misBefore.totals.oex, misAfter.totals.oex);
  row('EBITDA', misBefore.totals.rev - misBefore.totals.cos - misBefore.totals.emp - misBefore.totals.oex, misAfter.totals.rev - misAfter.totals.cos - misAfter.totals.emp - misAfter.totals.oex);
  row('PBT', misBefore.totals.pbt, misAfter.totals.pbt);
  row('PAT', misBefore.totals.pat, misAfter.totals.pat);
  console.log(`EBITDA margin   before: ${misBefore.totals.em.toFixed(2)}%   after: ${misAfter.totals.em.toFixed(2)}%`);
  console.log(`PAT margin      before: ${misBefore.totals.pm.toFixed(2)}%   after: ${misAfter.totals.pm.toFixed(2)}%`);
}

async function main() {
  await run('ddf3e124-1049-4d2c-b856-9a70f6a9f9a7', 'FY 2025-26 (current)');
  await run('7da1f80c-0e74-44dd-ae8d-35620ed67a29', 'FY 2024-25 (prior)');
  await pool.end();
}
main();
