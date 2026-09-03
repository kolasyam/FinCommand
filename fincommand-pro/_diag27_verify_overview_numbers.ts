/* eslint-disable no-console */
import 'dotenv/config';
import { Pool } from 'pg';
import { computeMIS, computeBS, type TbLedgerRow, type PeriodParams } from './lib/financial/tb-engine';

const pool = new Pool({
  host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function main() {
  const companyId = '1abb21f3-efc2-4772-bed7-899ca448e9f9';
  const fyId = 'ddf3e124-1049-4d2c-b856-9a70f6a9f9a7';

  const { rows: ledgers } = await pool.query<TbLedgerRow>(`
    SELECT l.* FROM tb_ledgers l JOIN tb_uploads u ON u.id = l.upload_id
    WHERE l.company_id=$1 AND l.financial_year_id=$2 AND u.is_current=TRUE
    ORDER BY l.ledger_name
  `, [companyId, fyId]);

  const params: PeriodParams = { periodType: 'annual', period: null, yearType: 'FY' };
  const mis = computeMIS(ledgers, params);
  const bs = computeBS(ledgers, params);
  const t = mis.totals;

  console.log('=== CURRENT (post-reclassification) Executive Overview numbers — FY 2025-26 ===');
  console.log(`Revenue:        ${t.rev.toLocaleString('en-IN')}`);
  console.log(`Cost of Svc:    ${t.cos.toLocaleString('en-IN')}`);
  console.log(`Employee Cost:  ${t.emp.toLocaleString('en-IN')}`);
  console.log(`Finance Costs:  ${t.fin.toLocaleString('en-IN')}`);
  console.log(`Depreciation:   ${t.dep.toLocaleString('en-IN')}`);
  console.log(`Other Expenses: ${t.oex.toLocaleString('en-IN')}`);
  console.log(`EBITDA:         ${(t.rev - t.cos - t.emp - t.oex).toLocaleString('en-IN')}`);
  console.log(`PBT:            ${t.pbt.toLocaleString('en-IN')}`);
  console.log(`Tax (25%):      ${t.tax.toLocaleString('en-IN')}`);
  console.log(`PAT:            ${t.pat.toLocaleString('en-IN')}`);
  console.log(`GM%:            ${t.gm.toFixed(2)}%`);
  console.log(`EBITDA%:        ${t.em.toFixed(2)}%`);
  console.log(`PAT%:           ${t.pm.toFixed(2)}%`);
  console.log(`\nBalance Sheet balanced: ${bs.balanced} (diff: ${bs.difference})`);
  console.log(`Total Assets: ${bs.assets.total.toLocaleString('en-IN')} | NCA: ${bs.assets.total_nca.toLocaleString('en-IN')} | CA: ${bs.assets.total_ca.toLocaleString('en-IN')}`);
  console.log(`Total E&L: ${bs.equity_liabilities.total.toLocaleString('en-IN')} | Equity: ${bs.equity_liabilities.total_equity.toLocaleString('en-IN')} | NCL: ${bs.equity_liabilities.total_ncl.toLocaleString('en-IN')} | CL: ${bs.equity_liabilities.total_cl.toLocaleString('en-IN')}`);

  await pool.end();
}

main();
