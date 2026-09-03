import type { NextRequest } from 'next/server';
import * as XLSX from 'xlsx';
import { v4 as uuid } from 'uuid';
import { authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { query, withTransaction } from '@/lib/db/neon';
import { logAudit } from '@/lib/audit/audit';
import { invalidateReportCache } from '@/lib/cache/report-cache';
import { isCurrencyCode } from '@/lib/services/currency';

export const runtime = 'nodejs';

const FY_MONTHS = ['Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar'];
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE_MB || '50') * 1024 * 1024;

interface LedgerMasterRow {
  ledger_code: string | null; ledger_name: string; note_no: number | null;
  note_name: string | null; section: string | null; treasury_type: string | null; normal_bal: string;
}

interface FyRow { id: string; is_locked: boolean }

// Detects a column index by matching header text against candidate substrings —
// ported verbatim from routes/trialBalance.js `fi()`.
function findColumn(hdr: unknown[], ...needles: string[]): number {
  for (const needle of needles) {
    const i = hdr.findIndex(h => String(h || '').toLowerCase().replace(/[_\s-]/g, '').includes(needle));
    if (i >= 0) return i;
  }
  return -1;
}

export const POST = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.canWrite);

  const formData = await req.formData();
  const file = formData.get('trial_balance');
  const financial_year_id = formData.get('financial_year_id');
  // Source Currency for this Trial Balance (IAS 21 / IND AS 21) — optional:
  // the uploader confirms/changes it per upload (see UploadTab.tsx's Trial
  // Balance Currency selector). Omitted or not one of the 5 supported codes
  // leaves companies.currency exactly as it was (DB default 'INR' for a
  // brand-new company), never silently resets it.
  const currencyRaw = formData.get('currency');
  const currency = typeof currencyRaw === 'string' && isCurrencyCode(currencyRaw.toUpperCase())
    ? currencyRaw.toUpperCase()
    : null;

  if (!file || !(file instanceof File)) return json({ error: 'No file uploaded' }, { status: 400 });
  if (typeof financial_year_id !== 'string' || !financial_year_id) {
    return json({ error: 'financial_year_id required' }, { status: 400 });
  }
  if (!/\.(xlsx|xls)$/i.test(file.name)) {
    return json({ error: 'Only .xlsx and .xls files allowed' }, { status: 400 });
  }
  if (file.size > MAX_FILE_SIZE) {
    return json({ error: `File exceeds ${process.env.MAX_FILE_SIZE_MB || '50'}MB limit` }, { status: 413 });
  }

  const { rows: fyRows } = await query<FyRow>(
    `SELECT * FROM financial_years WHERE id=$1 AND company_id=$2`,
    [financial_year_id, user.company_id]
  );
  if (!fyRows.length) return json({ error: 'Financial year not found' }, { status: 404 });
  if (fyRows[0].is_locked) return json({ error: 'This financial year is locked (post-audit)' }, { status: 403 });

  const uploadId = uuid();
  const buffer = Buffer.from(await file.arrayBuffer());

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: 'buffer' });
  } catch (e) {
    return json({ error: 'Cannot read Excel file: ' + (e as Error).message }, { status: 422 });
  }

  // ── Flexible Trial Balance sheet detection ──
  // Try exact match first, then common variations (case-insensitive), then
  // first sheet if it has the right header columns. This lets users upload
  // files from Tally, SAP, Zoho Books, etc. without renaming sheets.
  const TB_CANDIDATES = ['Trial_Balance', 'Trial Balance', 'TrialBalance', 'TB', 'trial_balance', 'Sheet1'];
  let tbSheetName: string | undefined;

  // 1. Exact match from candidates
  for (const candidate of TB_CANDIDATES) {
    if (wb.SheetNames.includes(candidate)) { tbSheetName = candidate; break; }
  }

  // 2. Case-insensitive match
  if (!tbSheetName) {
    const lower = wb.SheetNames.map(n => n.toLowerCase().replace(/[\s_-]/g, ''));
    const idx = lower.findIndex(n => n === 'trialbalance' || n === 'tb');
    if (idx >= 0) tbSheetName = wb.SheetNames[idx];
  }

  // 3. First sheet that contains recognisable TB header columns
  if (!tbSheetName) {
    for (const sn of wb.SheetNames) {
      const peek: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1 });
      const hdrRow = peek[0] || [];
      const hdrStr = hdrRow.map(h => String(h || '').toLowerCase().replace(/[\s_-]/g, '')).join('|');
      if (hdrStr.includes('ledgername') || hdrStr.includes('ledgercode') ||
          (hdrStr.includes('openingdr') && hdrStr.includes('openingcr'))) {
        tbSheetName = sn;
        break;
      }
    }
  }

  if (!tbSheetName) {
    return json({
      error: `No Trial Balance sheet found. Your file has sheets: [${wb.SheetNames.join(', ')}]. `
           + `Please use the downloaded template or ensure your file has a sheet named "Trial_Balance" `
           + `with columns: Ledger_Code, Ledger_Name, Opening_Dr, Opening_Cr, Apr_Dr … Mar_Cr.`
    }, { status: 422 });
  }

  const tbRaw: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[tbSheetName], { header: 1 });
  const hdr = tbRaw[0] || [];

  const ci = {
    code: findColumn(hdr, 'ledgercode', 'ledger_code', 'code'),
    name: findColumn(hdr, 'ledgername', 'ledger_name', 'name', 'account'),
    op_dr: findColumn(hdr, 'openingdr', 'opening_dr', 'opdr'),
    op_cr: findColumn(hdr, 'openingcr', 'opening_cr', 'opcr'),
  };
  if (ci.name < 0) return json({ error: 'Ledger_Name column not found. Use template.' }, { status: 422 });
  if (ci.op_dr < 0 || ci.op_cr < 0) return json({ error: 'Opening_Dr / Opening_Cr columns not found. Use template.' }, { status: 422 });

  const monthCols = FY_MONTHS.map(m => ({
    dr: findColumn(hdr, `${m.toLowerCase()}dr`, `${m}_dr`),
    cr: findColumn(hdr, `${m.toLowerCase()}cr`, `${m}_cr`),
  }));
  const hasMonthlyCols = monthCols.every(mc => mc.dr >= 0 && mc.cr >= 0);

  const { rows: lmRows } = await query<LedgerMasterRow>(
    `SELECT * FROM ledger_master
     WHERE (company_id=$1 OR company_id IS NULL) AND is_active=TRUE
     ORDER BY company_id NULLS LAST`,
    [user.company_id]
  );
  const lmByCode = new Map(lmRows.map(r => [r.ledger_code, r]));
  const lmByName = new Map(lmRows.map(r => [r.ledger_name.toLowerCase(), r]));

  // Check for uploaded Ledger_Master sheet and override/supplement database master mappings
  const LM_CANDIDATES = ['Ledger_Master', 'Ledger Master', 'LedgerMaster', 'ledger_master'];
  let lmSheetName: string | undefined;
  for (const candidate of LM_CANDIDATES) {
    if (wb.SheetNames.includes(candidate)) { lmSheetName = candidate; break; }
  }

  if (lmSheetName) {
    const lmRaw: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[lmSheetName], { header: 1 });
    const lmHdr = lmRaw[0] || [];
    const lmCi = {
      code: findColumn(lmHdr, 'ledgercode', 'ledger_code', 'code'),
      name: findColumn(lmHdr, 'ledgername', 'ledger_name', 'name', 'account'),
      note_no: findColumn(lmHdr, 'noteno', 'note_no', 'note'),
      note_name: findColumn(lmHdr, 'notename', 'note_name'),
      section: findColumn(lmHdr, 'section', 'sec'),
      treasury_type: findColumn(lmHdr, 'treasurytype', 'treasury_type', 'treasury'),
      normal_bal: findColumn(lmHdr, 'normalbalance', 'normal_bal', 'balance', 'norm'),
    };

    lmRaw.slice(1).forEach(r => {
      if (!r || r.length === 0) return;
      const code = lmCi.code >= 0 ? String(r[lmCi.code] || '').trim() : '';
      const name = lmCi.name >= 0 ? String(r[lmCi.name] || '').trim() : '';
      if (!code && !name) return;

      const noteNoVal = lmCi.note_no >= 0 ? parseInt(String(r[lmCi.note_no])) : NaN;
      const lmObj: LedgerMasterRow = {
        ledger_code: code || null,
        ledger_name: name,
        note_no: !isNaN(noteNoVal) ? noteNoVal : null,
        note_name: lmCi.note_name >= 0 ? String(r[lmCi.note_name] || '').trim() || null : null,
        section: lmCi.section >= 0 ? String(r[lmCi.section] || '').trim() || null : null,
        treasury_type: lmCi.treasury_type >= 0 ? String(r[lmCi.treasury_type] || '').trim() || null : null,
        normal_bal: lmCi.normal_bal >= 0 ? String(r[lmCi.normal_bal] || '').trim() || 'Dr' : 'Dr',
      };

      if (code) lmByCode.set(code, lmObj);
      if (name) lmByName.set(name.toLowerCase(), lmObj);
    });
  }

  interface ParsedRow {
    code: string; name: string; op_dr: number; op_cr: number;
    note_no: number | null; note_name: string | null; section: string | null;
    treasury_type: string | null; normal_bal: string;
    [key: string]: unknown;
  }
  const rows: ParsedRow[] = [];
  let mapped = 0;
  const unmatched: string[] = [];

  tbRaw.slice(1).forEach(r => {
    if (!r[ci.name]) return;
    const name = String(r[ci.name]).trim();
    const code = ci.code >= 0 ? String(r[ci.code] || '').trim() : '';
    const lm = lmByCode.get(code) || lmByName.get(name.toLowerCase());
    if (lm) mapped++; else if (name) unmatched.push(name);

    const row: ParsedRow = {
      code, name,
      op_dr: parseFloat(String(r[ci.op_dr])) || 0,
      op_cr: parseFloat(String(r[ci.op_cr])) || 0,
      note_no: lm?.note_no ?? null,
      note_name: lm?.note_name ?? null,
      section: lm?.section ?? null,
      treasury_type: lm?.treasury_type ?? null,
      normal_bal: lm?.normal_bal || 'Dr',
    };
    monthCols.forEach((mc, mi) => {
      const monthNum = mi + 1;
      row[`m${monthNum}_dr`] = mc.dr >= 0 ? (parseFloat(String(r[mc.dr])) || 0) : 0;
      row[`m${monthNum}_cr`] = mc.cr >= 0 ? (parseFloat(String(r[mc.cr])) || 0) : 0;
    });
    rows.push(row);
  });

  const coverage = rows.length > 0 ? Math.round(mapped / rows.length * 100) : 0;

  await withTransaction(async (client) => {
    if (currency) {
      await client.query(
        `UPDATE companies SET currency=$1, updated_at=NOW() WHERE id=$2`,
        [currency, user.company_id]
      );
    }

    await client.query(
      `UPDATE tb_uploads SET is_current=FALSE, status='superseded'
       WHERE company_id=$1 AND financial_year_id=$2 AND is_current=TRUE`,
      [user.company_id, financial_year_id]
    );

    await client.query(
      `INSERT INTO tb_uploads
         (id, company_id, financial_year_id, uploaded_by, source, filename,
          file_size_kb, ledger_count, mapped_count, unmatched_count,
          unmatched_ledgers, coverage_pct, has_monthly_cols, status, is_current)
       VALUES ($1,$2,$3,$4,'excel',$5,$6,$7,$8,$9,$10,$11,$12,'complete',TRUE)`,
      [uploadId, user.company_id, financial_year_id, user.id,
       file.name, Math.round(file.size / 1024),
       rows.length, mapped, unmatched.length, JSON.stringify(unmatched.slice(0, 50)),
       coverage, hasMonthlyCols]
    );

    for (const row of rows) {
      await client.query(
        `INSERT INTO tb_ledgers
          (upload_id, company_id, financial_year_id, ledger_code, ledger_name,
           note_no, note_name, section, treasury_type, normal_bal,
           op_dr, op_cr,
           m1_dr,m1_cr, m2_dr,m2_cr, m3_dr,m3_cr, m4_dr,m4_cr,
           m5_dr,m5_cr, m6_dr,m6_cr, m7_dr,m7_cr, m8_dr,m8_cr,
           m9_dr,m9_cr, m10_dr,m10_cr, m11_dr,m11_cr, m12_dr,m12_cr)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                $13,$14,$15,$16,$17,$18,$19,$20,
                $21,$22,$23,$24,$25,$26,$27,$28,
                $29,$30,$31,$32,$33,$34,$35,$36)`,
        [uploadId, user.company_id, financial_year_id,
         row.code || null, row.name,
         row.note_no, row.note_name, row.section, row.treasury_type, row.normal_bal,
         row.op_dr, row.op_cr,
         row.m1_dr, row.m1_cr, row.m2_dr, row.m2_cr, row.m3_dr, row.m3_cr,
         row.m4_dr, row.m4_cr, row.m5_dr, row.m5_cr, row.m6_dr, row.m6_cr,
         row.m7_dr, row.m7_cr, row.m8_dr, row.m8_cr, row.m9_dr, row.m9_cr,
         row.m10_dr, row.m10_cr, row.m11_dr, row.m11_cr, row.m12_dr, row.m12_cr]
      );
    }
  });

  invalidateReportCache(user.company_id);
  logAudit(req, user, 'TB_UPLOAD', 'tb_upload', uploadId);

  return json({
    upload_id: uploadId,
    ledger_count: rows.length,
    mapped_count: mapped,
    unmatched_count: unmatched.length,
    coverage_pct: coverage,
    has_monthly_cols: hasMonthlyCols,
    unmatched_sample: unmatched.slice(0, 10),
    message: `Trial Balance uploaded. ${rows.length} ledgers processed, ${mapped} mapped (${coverage}% coverage).`,
  }, { status: 201 });
});
