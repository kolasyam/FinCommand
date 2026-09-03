import 'dotenv/config';
import { Pool } from 'pg';
import { computeCashFlow } from './lib/financial/tb-engine';
import type { TbLedgerRow } from './lib/financial/tb-engine';

const pool = new Pool({
  host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function main() {
  const companyId = '1abb21f3-efc2-4772-bed7-899ca448e9f9';
  const fyId = 'ddf3e124-1049-4d2c-b856-9a70f6a9f9a7';
  const { rows } = await pool.query(
    `SELECT l.* FROM tb_ledgers l JOIN tb_uploads u ON u.id = l.upload_id
     WHERE l.company_id=$1 AND l.financial_year_id=$2 AND u.is_current=TRUE`,
    [companyId, fyId]
  );
  const ledgers = rows as unknown as TbLedgerRow[];
  const cf = computeCashFlow(ledgers, { periodType: 'annual', yearType: 'FY' });

  console.log('operating.tax_paid:', (cf.operating as any).tax_paid);
  console.log('operating.total (Net Cash from Ops):', (cf.operating as any).total);
  console.log('operating.operating_profit:', (cf.operating as any).operating_profit);
  console.log('net_change:', cf.net_change);
  console.log('opening_cash:', cf.opening_cash);
  console.log('closing_cash:', cf.closing_cash);
  console.log('reconciling_gap:', cf.reconciling_gap);
  console.log('free_cash_flow:', cf.free_cash_flow);
  console.log('ocf_to_pat:', cf.ocf_to_pat);
  console.log('\nSanity: opening + net_change + reconciling_gap should == closing');
  console.log(cf.opening_cash + cf.net_change + cf.reconciling_gap, 'vs', cf.closing_cash);

  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
