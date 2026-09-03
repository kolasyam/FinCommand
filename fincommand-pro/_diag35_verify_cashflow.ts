/* eslint-disable no-console */
import 'dotenv/config';
import { Pool } from 'pg';
import { computeCashFlow, type TbLedgerRow, type PeriodParams } from './lib/financial/tb-engine';

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
  `, [companyId, fyId]);

  const params: PeriodParams = { periodType: 'annual', period: null, yearType: 'FY' };
  const cf = computeCashFlow(ledgers, params);
  console.log('=== Cash Flow — FY 2025-26 (post-fix) ===');
  console.log(JSON.stringify(cf, null, 2));
  await pool.end();
}
main();
