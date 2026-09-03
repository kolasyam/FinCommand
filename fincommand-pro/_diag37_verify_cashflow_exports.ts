/* eslint-disable no-console */
import 'dotenv/config';
import { Pool } from 'pg';
import fs from 'fs';
import {
  computeMIS, computeBS, computePL, computeNotes, computeTreasury, computeCashFlow, computeRatios,
  computeTopCustomers, resolvePeriod, type TbLedgerRow, type PeriodParams,
} from './lib/financial/tb-engine';
import type { ReportBundle } from './lib/dashboard/types';

const pool = new Pool({
  host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function main() {
  const companyId = '1abb21f3-efc2-4772-bed7-899ca448e9f9';
  const fyId = 'ddf3e124-1049-4d2c-b856-9a70f6a9f9a7';
  const prevFyId = '7da1f80c-0e74-44dd-ae8d-35620ed67a29';

  const { rows: ledgers } = await pool.query<TbLedgerRow>(`
    SELECT l.* FROM tb_ledgers l JOIN tb_uploads u ON u.id = l.upload_id
    WHERE l.company_id=$1 AND l.financial_year_id=$2 AND u.is_current=TRUE
  `, [companyId, fyId]);
  const { rows: prevLedgers } = await pool.query<TbLedgerRow>(`
    SELECT l.* FROM tb_ledgers l JOIN tb_uploads u ON u.id = l.upload_id
    WHERE l.company_id=$1 AND l.financial_year_id=$2 AND u.is_current=TRUE
  `, [companyId, prevFyId]);
  const { rows: custRows } = await pool.query(`
    SELECT c.id, c.customer_name, c.zoho_customer_id, c.m1,c.m2,c.m3,c.m4,c.m5,c.m6,c.m7,c.m8,c.m9,c.m10,c.m11,c.m12
    FROM tb_customer_revenue c JOIN tb_uploads u ON u.id=c.upload_id
    WHERE c.company_id=$1 AND c.financial_year_id=$2 AND u.is_current=TRUE
  `, [companyId, fyId]);

  const params: PeriodParams = { periodType: 'annual', period: null, yearType: 'FY' };
  const mis = computeMIS(ledgers, params);
  const bs = computeBS(ledgers, params);
  const pl = computePL(ledgers, params);
  const notesMap = computeNotes(ledgers, params);
  const treasury = computeTreasury(ledgers, params);
  const cashflow = computeCashFlow(ledgers, params);
  const prev_cashflow = computeCashFlow(prevLedgers, params);
  const ratios = computeRatios(ledgers, params);
  const top_customers = computeTopCustomers(custRows, ledgers, params, mis.totals.rev);
  const prev_mis = computeMIS(prevLedgers, params);

  const bundle: ReportBundle = {
    financial_year: { id: fyId, label: 'FY 2025-26', short_label: 'FY26', start_date: '2025-04-01', end_date: '2026-03-31', is_locked: false },
    prev_financial_year: { id: prevFyId, label: 'FY 2024-25', short_label: 'FY25', start_date: '2024-04-01', end_date: '2025-03-31', is_locked: false },
    period_params: params,
    period_label: resolvePeriod(params).label,
    mis, prev_mis, bs, pl,
    notes: Object.values(notesMap).sort((a, b) => a.note_no - b.note_no),
    treasury, cashflow, prev_cashflow, ratios, top_customers,
    generated_at: new Date().toISOString(),
  };

  console.log('=== Cash Flow bundle built OK ===');
  console.log('OCF:', cashflow.operating.total, '| ICF:', (cashflow.investing as any).total, '| FCF:', (cashflow.financing as any).total);
  console.log('Reconciling gap:', cashflow.reconciling_gap);

  const { buildCashFlowPdf } = await import('./lib/exports/cashflow-pdf');
  const { doc } = buildCashFlowPdf(bundle, 'Real Variable (Test)');
  const pdfBytes = doc.output('arraybuffer') as ArrayBuffer;
  fs.writeFileSync('_diag37_cashflow_test.pdf', Buffer.from(pdfBytes));
  console.log(`\n✅ Cash Flow PDF generated: ${pdfBytes.byteLength} bytes, ${doc.getNumberOfPages()} page(s)`);

  const XLSX = await import('xlsx');
  const { buildCashFlowXlsx } = await import('./lib/exports/cashflow-xlsx');
  const { wb } = buildCashFlowXlsx(bundle, 'Real Variable (Test)');
  const xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  fs.writeFileSync('_diag37_cashflow_test.xlsx', xlsxBuf);
  console.log(`✅ Cash Flow XLSX generated: ${xlsxBuf.length} bytes, sheets: ${wb.SheetNames.join(', ')}`);

  await pool.end();
}
main();
