/* eslint-disable no-console */
import 'dotenv/config';
import { Pool } from 'pg';
import fs from 'fs';
import {
  computeMIS, computeBS, computePL, computeNotes, computeTreasury, computeCashFlow, computeRatios,
  computeTopCustomers, resolvePeriod, type TbLedgerRow, type PeriodParams,
} from './lib/financial/tb-engine';
import type { ReportBundle } from './lib/dashboard/types';
import type { DisplayUnit } from './lib/utils/format';

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
  const prev_treasury = computeTreasury(prevLedgers, params);
  const prev_cashflow = computeCashFlow(prevLedgers, params);

  const bundle: ReportBundle = {
    financial_year: { id: fyId, label: 'FY 2025-26', short_label: 'FY26', start_date: '2025-04-01', end_date: '2026-03-31', is_locked: false },
    prev_financial_year: { id: prevFyId, label: 'FY 2024-25', short_label: 'FY25', start_date: '2024-04-01', end_date: '2025-03-31', is_locked: false },
    period_params: params,
    period_label: resolvePeriod(params).label,
    mis, prev_mis, bs, prev_bs, pl, prev_pl,
    notes: Object.values(notesMap).sort((a, b) => a.note_no - b.note_no),
    prev_notes: Object.values(prevNotesMap).sort((a, b) => a.note_no - b.note_no),
    treasury, prev_treasury, cashflow, prev_cashflow, ratios, top_customers,
    generated_at: new Date().toISOString(),
  };

  console.log('=== Bundle built OK — Revenue:', mis.totals.rev, '| Total Assets:', bs.assets.total, '===\n');

  const XLSX = await import('xlsx');

  // ── 1. bs-xlsx: unit scaling + compare gating on real cell values ──
  console.log('[1] bs-xlsx — unit scaling + compare gating');
  {
    const { buildBsXlsx } = await import('./lib/exports/bs-xlsx');
    const { wb: wbL } = buildBsXlsx(bundle, 'Real Variable (Test)', 'Lakhs' as DisplayUnit, true);
    const { wb: wbCr } = buildBsXlsx(bundle, 'Real Variable (Test)', 'Crores' as DisplayUnit, true);
    const { wb: wbNoCmp } = buildBsXlsx(bundle, 'Real Variable (Test)', 'Lakhs' as DisplayUnit, false);

    const sheetL = wbL.Sheets[wbL.SheetNames.find(n => /Equity/i.test(n)) || wbL.SheetNames[0]];
    const sheetCr = wbCr.Sheets[wbCr.SheetNames.find(n => /Equity/i.test(n)) || wbCr.SheetNames[0]];
    const aoaL = XLSX.utils.sheet_to_json(sheetL, { header: 1 }) as unknown[][];
    const aoaCr = XLSX.utils.sheet_to_json(sheetCr, { header: 1 }) as unknown[][];

    const findTotalRow = (aoa: unknown[][]) => aoa.find(r => String(r[0] || '').includes('TOTAL EQUITY'));
    const rowL = findTotalRow(aoaL);
    const rowCr = findTotalRow(aoaCr);
    check('bs-xlsx: found TOTAL EQUITY & LIABILITIES row (Lakhs)', !!rowL);
    check('bs-xlsx: found TOTAL EQUITY & LIABILITIES row (Crores)', !!rowCr);
    if (rowL && rowCr) {
      const valL = Number(rowL[2]);
      const valCr = Number(rowCr[2]);
      console.log(`     Lakhs total: ${valL}, Crores total: ${valCr}, ratio: ${(valL / valCr).toFixed(2)}`);
      check('bs-xlsx: Lakhs value is ~100x the Crores value (unit conversion applied)', Math.abs(valL / valCr - 100) < 0.5);
    }

    const headerRowL = aoaL.find(r => Array.isArray(r) && r.some(c => typeof c === 'string' && c.includes('YoY')));
    const headerRowNoCmp = (XLSX.utils.sheet_to_json(wbNoCmp.Sheets[wbNoCmp.SheetNames.find(n => /Equity/i.test(n)) || wbNoCmp.SheetNames[0]], { header: 1 }) as unknown[][])
      .find(r => Array.isArray(r) && r.some(c => typeof c === 'string' && c.includes('Note')));
    check('bs-xlsx: compare=true sheet has a YoY column header', !!headerRowL);
    check('bs-xlsx: compare=false sheet has NO YoY column (fewer columns)', !!headerRowNoCmp && headerRowNoCmp.length <= 3);
  }

  // ── 2. treasury-xlsx: unit scaling ──
  console.log('\n[2] treasury-xlsx — unit scaling');
  {
    const { buildTreasuryXlsx } = await import('./lib/exports/treasury-xlsx');
    const { wb: wbK } = buildTreasuryXlsx(bundle, 'Real Variable (Test)', 'Thousands' as DisplayUnit, true);
    const { wb: wbL } = buildTreasuryXlsx(bundle, 'Real Variable (Test)', 'Lakhs' as DisplayUnit, true);
    const sheetK = wbK.Sheets[wbK.SheetNames[0]];
    const sheetL = wbL.Sheets[wbL.SheetNames[0]];
    const aoaK = XLSX.utils.sheet_to_json(sheetK, { header: 1 }) as unknown[][];
    const aoaL = XLSX.utils.sheet_to_json(sheetL, { header: 1 }) as unknown[][];
    const totRowK = aoaK.find(r => String(r[0] || '').toUpperCase().includes('TOTAL TREASURY') || String(r[0] || '').toUpperCase().includes('TOTAL'));
    console.log('    Thousands sheet rows:', aoaK.length, '| Lakhs sheet rows:', aoaL.length);
    check('treasury-xlsx: generated non-trivial sheets for both units', aoaK.length > 3 && aoaL.length > 3);
  }

  // ── 3. getExportTables (generic path) — unit + compare on workingcapital/ratios ──
  console.log('\n[3] tables.ts generic path — unit + compare');
  {
    const { getExportTables } = await import('./lib/exports/tables');
    const wcLakhs = getExportTables('workingcapital', bundle, 'Lakhs' as DisplayUnit, true);
    const wcCrores = getExportTables('workingcapital', bundle, 'Crores' as DisplayUnit, true);
    const caRowL = wcLakhs[0].rows.find(r => String(r[0]).includes('Current Assets'));
    const caRowCr = wcCrores[0].rows.find(r => String(r[0]).includes('Current Assets'));
    check('tables.ts: workingcapital header reflects unit (Lakhs)', wcLakhs[0].rows.some(r => String(r[0]).includes('(₹L)')));
    check('tables.ts: workingcapital header reflects unit (Crores)', wcCrores[0].rows.some(r => String(r[0]).includes('(₹Cr)')));
    if (caRowL && caRowCr) {
      console.log(`     Current Assets — Lakhs: ${caRowL[1]}, Crores: ${caRowCr[1]}`);
    }

    const bsCompareOn = getExportTables('bs', bundle, 'Lakhs' as DisplayUnit, true);
    const bsCompareOff = getExportTables('bs', bundle, 'Lakhs' as DisplayUnit, false);
    check('tables.ts: bs compare=true has 5-col header (YoY)', bsCompareOn[0].columns.length === 5);
    check('tables.ts: bs compare=false has 3-col header (no YoY)', bsCompareOff[0].columns.length === 3);
  }

  // ── 4. Runtime smoke test: every bespoke PDF builder × every unit × compare on/off ──
  console.log('\n[4] Runtime smoke test — all 7 bespoke PDF builders × 3 units × 2 compare states');
  {
    const builders: [string, (b: ReportBundle, c: string, u: DisplayUnit, cmp: boolean) => { doc: { output: (t: string) => ArrayBuffer; getNumberOfPages: () => number } }][] = [
      ['overview', (await import('./lib/exports/overview-pdf')).buildOverviewPdf as any],
      ['mis', (await import('./lib/exports/mis-pdf')).buildMisPdf as any],
      ['bs', (await import('./lib/exports/bs-pdf')).buildBsPdf as any],
      ['pl', (await import('./lib/exports/pl-pdf')).buildPlPdf as any],
      ['notes', (await import('./lib/exports/notes-pdf')).buildNotesPdf as any],
      ['treasury', (await import('./lib/exports/treasury-pdf')).buildTreasuryPdf as any],
      ['cashflow', (await import('./lib/exports/cashflow-pdf')).buildCashFlowPdf as any],
    ];
    const units: DisplayUnit[] = ['Lakhs', 'Thousands', 'Crores'];
    let ok = true;
    for (const [name, build] of builders) {
      for (const unit of units) {
        for (const compare of [true, false]) {
          try {
            const { doc } = build(bundle, 'Real Variable (Test)', unit, compare);
            const bytes = doc.output('arraybuffer') as ArrayBuffer;
            if (bytes.byteLength < 500) throw new Error('suspiciously small PDF');
          } catch (e) {
            ok = false;
            console.log(`     ❌ ${name} unit=${unit} compare=${compare}:`, (e as Error).message);
          }
        }
      }
    }
    check('all 7 bespoke PDF builders run clean across every unit × compare combo (42 calls)', ok);
  }

  // ── 5. Runtime smoke test: all 7 bespoke XLSX builders × unit × compare ──
  console.log('\n[5] Runtime smoke test — all 7 bespoke XLSX builders × 3 units × 2 compare states');
  {
    const builders: [string, (b: ReportBundle, c: string, u: DisplayUnit, cmp: boolean) => { wb: unknown }][] = [
      ['overview', (await import('./lib/exports/overview-xlsx')).buildOverviewXlsx as any],
      ['mis', (await import('./lib/exports/mis-xlsx')).buildMisXlsx as any],
      ['bs', (await import('./lib/exports/bs-xlsx')).buildBsXlsx as any],
      ['pl', (await import('./lib/exports/pl-xlsx')).buildPlXlsx as any],
      ['notes', (await import('./lib/exports/notes-xlsx')).buildNotesXlsx as any],
      ['treasury', (await import('./lib/exports/treasury-xlsx')).buildTreasuryXlsx as any],
      ['cashflow', (await import('./lib/exports/cashflow-xlsx')).buildCashFlowXlsx as any],
    ];
    const units: DisplayUnit[] = ['Lakhs', 'Thousands', 'Crores'];
    let ok = true;
    for (const [name, build] of builders) {
      for (const unit of units) {
        for (const compare of [true, false]) {
          try {
            const { wb } = build(bundle, 'Real Variable (Test)', unit, compare);
            const buf = XLSX.write(wb as import('xlsx').WorkBook, { type: 'buffer', bookType: 'xlsx' });
            if (buf.length < 500) throw new Error('suspiciously small XLSX');
          } catch (e) {
            ok = false;
            console.log(`     ❌ ${name} unit=${unit} compare=${compare}:`, (e as Error).message);
          }
        }
      }
    }
    check('all 7 bespoke XLSX builders run clean across every unit × compare combo (42 calls)', ok);
  }

  // ── 6. buildSectionPdf / getExportTables generic path smoke test for remaining 6 sections ──
  console.log('\n[6] Generic exporter (tables.ts + buildSectionPdf) — remaining 6 sections');
  {
    const { buildSectionPdf } = await import('./lib/exports/pdf');
    const sections = ['ratios', 'workingcapital', 'alerts', 'compliance', 'boardpack', 'scenario'];
    let ok = true;
    for (const section of sections) {
      for (const unit of ['Lakhs', 'Crores'] as DisplayUnit[]) {
        for (const compare of [true, false]) {
          try {
            const { doc } = buildSectionPdf(section, bundle, 'Real Variable (Test)', unit, compare);
            const bytes = doc.output('arraybuffer') as ArrayBuffer;
            if (bytes.byteLength < 500) throw new Error('suspiciously small PDF');
          } catch (e) {
            ok = false;
            console.log(`     ❌ ${section} unit=${unit} compare=${compare}:`, (e as Error).message);
          }
        }
      }
    }
    check('all 6 generic-path sections run clean across unit × compare combos', ok);
  }

  // Save one representative pair for manual spot-check.
  const { buildBsPdf } = await import('./lib/exports/bs-pdf');
  const { doc: bsCroresDoc } = buildBsPdf(bundle, 'Real Variable (Test)', 'Crores' as DisplayUnit, false);
  fs.writeFileSync('_diag67_bs_crores_nocompare.pdf', Buffer.from(bsCroresDoc.output('arraybuffer') as ArrayBuffer));
  console.log('\nSaved _diag67_bs_crores_nocompare.pdf for manual spot-check (should say "Rs. in Crores", no YoY column).');

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  await pool.end();
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
