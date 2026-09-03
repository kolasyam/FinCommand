import 'dotenv/config';
import { query } from './lib/db/neon';
import { computeBS, computeMIS, computePL, computeCashFlow, computeTreasury, type TbLedgerRow } from './lib/financial/tb-engine';

const companyId = '1abb21f3-efc2-4772-bed7-899ca448e9f9';
const fyId = 'ddf3e124-1049-4d2c-b856-9a70f6a9f9a7';

(async () => {
  const { rows } = await query<TbLedgerRow>(
    `SELECT l.* FROM tb_ledgers l JOIN tb_uploads u ON u.id = l.upload_id
     WHERE l.company_id=$1 AND l.financial_year_id=$2 AND u.is_current=TRUE ORDER BY l.ledger_name`,
    [companyId, fyId]
  );
  console.log('Ledger rows loaded:', rows.length);

  const params = { periodType: 'annual' as const, period: null, yearType: 'FY' as const };

  const mis = computeMIS(rows, params);
  const pl = computePL(rows, params);
  const bs = computeBS(rows, params);
  const cf = computeCashFlow(rows, params);
  const tsy = computeTreasury(rows, params);

  console.log('\n=== MIS totals (annual) ===');
  console.log(mis.totals);

  console.log('\n=== P&L (annual) ===');
  console.log({ revenue: pl.revenue, other_income: pl.other_income, total_income: pl.total_income,
    cos: pl.cos, employee_benefits: pl.employee_benefits, finance_costs: pl.finance_costs,
    depreciation: pl.depreciation, other_expenses: pl.other_expenses, total_expenses: pl.total_expenses,
    pbt: pl.pbt, current_tax: pl.current_tax, pat: pl.pat });

  console.log('\n=== Balance Sheet (annual) ===');
  console.log('Total Equity:', bs.equity_liabilities.total_equity);
  console.log('Total NCL:', bs.equity_liabilities.total_ncl);
  console.log('Total CL:', bs.equity_liabilities.total_cl);
  console.log('Total E&L:', bs.equity_liabilities.total);
  console.log('Total NCA:', bs.assets.total_nca);
  console.log('Total CA:', bs.assets.total_ca);
  console.log('Total Assets:', bs.assets.total);
  console.log('BALANCED?', bs.balanced, ' diff=', bs.difference);

  console.log('\n=== Treasury ===');
  console.log('Cash+Bank:', tsy.total_cash_and_bank, ' FD:', tsy.total_fd, ' MF:', tsy.total_mf, ' Total:', tsy.total);

  console.log('\n=== Cash Flow (annual) ===');
  console.log('Operating total:', (cf.operating as any).total);
  console.log('  wc_changes:', (cf.operating as any).wc_changes);
  console.log('Investing total:', (cf.investing as any).total);
  console.log('  detail:', cf.investing);
  console.log('Financing total:', (cf.financing as any).total);
  console.log('  detail:', cf.financing);
  console.log('Net change (statement):', cf.net_change);
  console.log('Opening cash (from BS):', cf.opening_cash);
  console.log('Closing cash (from BS):', cf.closing_cash);
  console.log('Real BS-derived net change (closing-opening):', cf.closing_cash - cf.opening_cash);
  console.log('Reconciliation gap (statement vs real):', cf.net_change - (cf.closing_cash - cf.opening_cash));

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
