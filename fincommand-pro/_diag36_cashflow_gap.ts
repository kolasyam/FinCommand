/* eslint-disable no-console */
import 'dotenv/config';
import { Pool } from 'pg';
import { computeCashFlow, computePL, computeBS, resolvePeriod, type TbLedgerRow, type PeriodParams } from './lib/financial/tb-engine';

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
  const pl = computePL(ledgers, params);
  const bs = computeBS(ledgers, params);

  const gap = cf.net_change - (cf.closing_cash - cf.opening_cash);
  console.log('net_change (derived):', cf.net_change);
  console.log('closing_cash - opening_cash (real):', cf.closing_cash - cf.opening_cash);
  console.log('GAP:', gap);
  console.log('\npl.pbt:', pl.pbt, '| pl.pat:', pl.pat, '| pl.current_tax:', pl.current_tax, '| pl.deferred_tax:', pl.deferred_tax);
  console.log('tax_paid used in OCF:', (cf.operating as any).tax_paid);

  // Real retained-earnings / other-equity movement, directly from ledgers
  const otherEquityLedgers = ledgers.filter(l => l.section === 'eq' && l.note_no === 2);
  const { plIndices, bsLastIdx } = resolvePeriod(params);
  const startIdx = plIndices[0] - 1;
  function bsRowBalanceAt(row: TbLedgerRow, atIdx: number): number {
    const n = (v: any) => parseFloat(String(v ?? '')) || 0;
    if (atIdx < 0) return row.normal_bal === 'Dr' ? (n(row.op_dr) - n(row.op_cr)) : (n(row.op_cr) - n(row.op_dr));
    // closingBalance equivalent
    let opNet = row.normal_bal === 'Dr' ? (n(row.op_dr) - n(row.op_cr)) : (n(row.op_cr) - n(row.op_dr));
    let net = opNet;
    for (let mi = 0; mi <= atIdx; mi++) {
      const mn = mi + 1;
      const dr = n(row[`m${mn}_dr`]); const cr = n(row[`m${mn}_cr`]);
      net += row.normal_bal === 'Dr' ? (dr - cr) : (cr - dr);
    }
    return net;
  }
  const oeStart = otherEquityLedgers.reduce((s, r) => s + bsRowBalanceAt(r, startIdx), 0);
  const oeEnd = otherEquityLedgers.reduce((s, r) => s + bsRowBalanceAt(r, bsLastIdx), 0);
  console.log('\nOther Equity (Note 2, incl. Retained Earnings) movement:', oeEnd - oeStart, '(start:', oeStart, 'end:', oeEnd, ')');
  console.log('vs pl.pat (modeled):', pl.pat, '-> difference:', (oeEnd - oeStart) - pl.pat);

  const shareCapitalLedgers = ledgers.filter(l => l.section === 'eq' && l.note_no === 1);
  const scStart = shareCapitalLedgers.reduce((s, r) => s + bsRowBalanceAt(r, startIdx), 0);
  const scEnd = shareCapitalLedgers.reduce((s, r) => s + bsRowBalanceAt(r, bsLastIdx), 0);
  console.log('Share Capital (Note 1) movement:', scEnd - scStart);

  console.log('\nBS balanced:', bs.balanced, 'diff:', bs.difference);
  await pool.end();
}
main();
