/* eslint-disable no-console */
import 'dotenv/config';
import { Pool } from 'pg';
import fs from 'fs';
import { computeMIS, computeBS, computePL, computeNotes, computeTreasury, computeCashFlow, computeRatios, resolvePeriod, type TbLedgerRow, type PeriodParams } from './lib/financial/tb-engine';
import type { ReportBundle } from './lib/dashboard/types';

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
  const mis = computeMIS(ledgers, params);
  const bs = computeBS(ledgers, params);
  const pl = computePL(ledgers, params);
  const notesMap = computeNotes(ledgers, params);
  const treasury = computeTreasury(ledgers, params);
  const cashflow = computeCashFlow(ledgers, params);
  const ratios = computeRatios(ledgers, params);

  const bundle: ReportBundle = {
    financial_year: { id: fyId, label: 'FY 2025-26', short_label: 'FY26', start_date: '2025-04-01', end_date: '2026-03-31', is_locked: false },
    period_params: params,
    period_label: resolvePeriod(params).label,
    mis, bs, pl,
    notes: Object.values(notesMap).sort((a, b) => a.note_no - b.note_no),
    treasury, cashflow, ratios,
    generated_at: new Date().toISOString(),
  };

  const { buildSectionPdf } = await import('./lib/exports/pdf');
  const { doc } = buildSectionPdf('bs', bundle, 'Real Variable (Test)');
  const bytes = doc.output('arraybuffer') as ArrayBuffer;
  fs.writeFileSync('_diag32_bs_test.pdf', Buffer.from(bytes));
  console.log(`✅ Balance Sheet PDF generated: ${bytes.byteLength} bytes, ${doc.getNumberOfPages()} page(s)`);
  await pool.end();
}
main().catch(e => { console.error('FAILED:', e); process.exit(1); });
