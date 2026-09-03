/* eslint-disable no-console */
// Verifies the "+—" fix end-to-end through the real call sites (tables.ts,
// bs-pdf.ts, notes-pdf.ts, pl-pdf.ts) using a synthetic near-zero YoY delta
// that reproduces the exact real-world scenario: curr - prev = 0.0000001,
// which satisfies `chg >= 0` but rounds under fl()'s EPSILON to "—".
import 'dotenv/config';
import { Pool } from 'pg';
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

let pass = 0, fail = 0;
function check(label: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}
function scanForPlusDash(rows: unknown, label: string) {
  const text = JSON.stringify(rows);
  check(`${label}: no "+—" anywhere in the output`, !text.includes('+—'));
}

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
  const ratios = computeRatios(ledgers, params);
  const top_customers = computeTopCustomers(custRows, ledgers, params, mis.totals.rev);
  const prev_mis = computeMIS(prevLedgers, params);
  const prev_bs = computeBS(prevLedgers, params);
  const prev_pl = computePL(prevLedgers, params);
  const prevNotesMap = computeNotes(prevLedgers, params);

  const notes = Object.values(notesMap).sort((a, b) => a.note_no - b.note_no);
  const prev_notes = Object.values(prevNotesMap).sort((a, b) => a.note_no - b.note_no);

  // ── Reproduce the exact real-world bug scenario ──
  // Force a genuinely tiny positive residual on Note 1's total (and its
  // matching prior-year total minus that residual), so curr - prev =
  // +0.0000001 exactly — satisfies `chg >= 0` while fl()'s EPSILON (0.005)
  // collapses the formatted value to "—".
  const TINY = 0.0000001;
  const rigged = JSON.parse(JSON.stringify(notes)) as typeof notes;
  const riggedPrev = JSON.parse(JSON.stringify(prev_notes)) as typeof prev_notes;
  if (rigged[0] && riggedPrev.find(n => n.note_no === rigged[0].note_no)) {
    const p = riggedPrev.find(n => n.note_no === rigged[0].note_no)!;
    rigged[0].total = p.total + TINY;
  }
  // Also rig BS's Total Equity vs prior year to the same tiny residual.
  const riggedBs = JSON.parse(JSON.stringify(bs)) as typeof bs;
  const riggedPrevBs = JSON.parse(JSON.stringify(prev_bs)) as typeof prev_bs;
  riggedBs.equity_liabilities.total_equity = riggedPrevBs.equity_liabilities.total_equity + TINY;
  // And P&L's PBT.
  const riggedPl = JSON.parse(JSON.stringify(pl)) as typeof pl;
  const riggedPrevPl = JSON.parse(JSON.stringify(prev_pl)) as typeof prev_pl;
  riggedPl.pbt = riggedPrevPl.pbt + TINY;

  const bundle: ReportBundle = {
    financial_year: { id: fyId, label: 'FY 2025-26', short_label: 'FY26', start_date: '2025-04-01', end_date: '2026-03-31', is_locked: false },
    prev_financial_year: { id: prevFyId, label: 'FY 2024-25', short_label: 'FY25', start_date: '2024-04-01', end_date: '2025-03-31', is_locked: false },
    period_params: params,
    period_label: resolvePeriod(params).label,
    mis, prev_mis, bs: riggedBs, prev_bs: riggedPrevBs, pl: riggedPl, prev_pl: riggedPrevPl,
    notes: rigged, prev_notes: riggedPrev,
    treasury, cashflow, ratios, top_customers,
    generated_at: new Date().toISOString(),
  };

  console.log(`=== Rigged bundle: Note ${rigged[0]?.note_no} chg = ${rigged[0]?.total - (riggedPrev.find(n => n.note_no === rigged[0]?.note_no)?.total ?? 0)}, BS equity chg = ${riggedBs.equity_liabilities.total_equity - riggedPrevBs.equity_liabilities.total_equity}, PL PBT chg = ${riggedPl.pbt - riggedPrevPl.pbt} ===\n`);

  // ── tables.ts (generic exporter) ──
  console.log('[1] tables.ts');
  {
    const { getExportTables } = await import('./lib/exports/tables');
    scanForPlusDash(getExportTables('bs', bundle, 'Lakhs', true), 'tables.ts bs');
    scanForPlusDash(getExportTables('notes', bundle, 'Lakhs', true), 'tables.ts notes');
    scanForPlusDash(getExportTables('pl', bundle, 'Lakhs', true), 'tables.ts pl');
  }

  // ── bs-pdf.ts / notes-pdf.ts / pl-pdf.ts (bespoke PDF, via raw PDF text) ──
  console.log('\n[2] Bespoke PDF builders — raw generated PDF text');
  {
    const { buildBsPdf } = await import('./lib/exports/bs-pdf');
    const { buildNotesPdf } = await import('./lib/exports/notes-pdf');
    const { buildPlPdf } = await import('./lib/exports/pl-pdf');

    const { doc: bsDoc } = buildBsPdf(bundle, 'Real Variable (Test)', 'Lakhs', true);
    const bsText = Buffer.from(bsDoc.output('arraybuffer') as ArrayBuffer).toString('latin1');
    check('bs-pdf: no "+—" in raw PDF bytes', !bsText.includes('+\xe2\x80\x94') && !bsText.includes('+—'));

    const { doc: notesDoc } = buildNotesPdf(bundle, 'Real Variable (Test)', 'Lakhs', true);
    const notesText = Buffer.from(notesDoc.output('arraybuffer') as ArrayBuffer).toString('latin1');
    check('notes-pdf: no "+—" in raw PDF bytes', !notesText.includes('+\xe2\x80\x94') && !notesText.includes('+—'));

    const { doc: plDoc } = buildPlPdf(bundle, 'Real Variable (Test)', 'Lakhs', true);
    const plText = Buffer.from(plDoc.output('arraybuffer') as ArrayBuffer).toString('latin1');
    check('pl-pdf: no "+—" in raw PDF bytes', !plText.includes('+\xe2\x80\x94') && !plText.includes('+—'));
  }

  // ── On-screen component logic (can't render React here, so call the
  //    exact same formatChg() call sites now used in the .tsx files) ──
  console.log('\n[3] formatChg() itself — the shared guard every tab now calls');
  {
    const { formatChg } = await import('./lib/utils/format');
    check('formatChg(0.0000001, 2, "Lakhs") === "—" (not "+—")', formatChg(0.0000001, 2, 'Lakhs') === '—');
    check('formatChg(-0.0000001, 2, "Lakhs") === "—"', formatChg(-0.0000001, 2, 'Lakhs') === '—');
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  await pool.end();
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
