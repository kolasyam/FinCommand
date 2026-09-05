import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { loadTemplate, loadLinesForTemplate, loadLineLedgerMap } from '@/lib/db/queries/report-builder';
import { loadLedgers, getFY } from '@/lib/db/queries/reports';
import { computeStatementReport } from '@/lib/financial/report-builder-engine';

export const runtime = 'nodejs';

/**
 * POST: runs a format against real ledger data for one financial year and a
 * set of month columns — this is the Report Viewer's "render" call. Amounts
 * are computed fresh every time, never stored (see report_saved_reports'
 * schema comment) — re-running an hour after a fresh Zoho sync shows the
 * new numbers automatically.
 */
export const POST = withErrorHandling(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const user = await authenticate(req);
  const { id } = await params;

  const template = await loadTemplate(user.company_id, id);
  if (!template) return json({ error: 'Template not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const financialYearId = String(body.financialYearId || '');
  const monthIndices: number[] = Array.isArray(body.monthIndices) ? body.monthIndices.map(Number) : [];
  if (!financialYearId) return json({ error: 'financialYearId is required' }, { status: 400 });
  if (monthIndices.length === 0) return json({ error: 'monthIndices[] must have at least one month' }, { status: 400 });
  if (monthIndices.some((mi) => !Number.isInteger(mi) || mi < 0 || mi > 11)) {
    return json({ error: 'monthIndices must be integers between 0 and 11' }, { status: 400 });
  }

  const fy = await getFY(user.company_id, financialYearId);
  if (!fy) return json({ error: 'Financial year not found' }, { status: 404 });

  const [lines, lineLedgerMap, ledgers] = await Promise.all([
    loadLinesForTemplate(id),
    loadLineLedgerMap(id),
    loadLedgers(user.company_id, financialYearId),
  ]);
  if (!ledgers.length) return json({ error: 'No Trial Balance data found for this financial year.' }, { status: 404 });

  const ledgersByName = new Map(ledgers.map((l) => [l.ledger_name, l]));
  const rows = computeStatementReport(lines, lineLedgerMap, ledgersByName, monthIndices);

  return json({ financial_year: fy, month_indices: monthIndices, rows, generated_at: new Date().toISOString() });
});
