import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { logAudit } from '@/lib/audit/audit';
import { loadSavedReports, createSavedReport } from '@/lib/db/queries/report-builder';
import { getFY } from '@/lib/db/queries/reports';

export const runtime = 'nodejs';

/** GET: "My Reports" — every saved run configuration for this company. Anyone who can view the dashboard can list/run saved reports; only admin/cfo can create/edit formats (see templates routes) — running a saved report doesn't need that restriction. */
export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  const reports = await loadSavedReports(user.company_id);
  return json({ reports });
});

/** POST: save a report run's configuration (template + FY + month columns + display toggle) — never the computed amounts, so reopening it always re-runs against the latest ledger data. */
export const POST = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  const body = await req.json().catch(() => ({}));

  const name = String(body.name || '').trim();
  const templateId = String(body.templateId || '');
  const financialYearId = String(body.financialYearId || '');
  const monthIndices: number[] = Array.isArray(body.monthIndices) ? body.monthIndices.map(Number) : [];
  const showPercent = Boolean(body.showPercent);

  if (!name) return json({ error: 'name is required' }, { status: 400 });
  if (!templateId) return json({ error: 'templateId is required' }, { status: 400 });
  if (!financialYearId) return json({ error: 'financialYearId is required' }, { status: 400 });
  if (monthIndices.length === 0) return json({ error: 'monthIndices[] must have at least one month' }, { status: 400 });

  const fy = await getFY(user.company_id, financialYearId);
  if (!fy) return json({ error: 'Financial year not found' }, { status: 404 });

  const report = await createSavedReport({
    companyId: user.company_id, templateId, financialYearId, name, monthIndices, showPercent, userId: user.id,
  });
  logAudit(req, user, 'report_builder.saved_report.create', 'report_saved_report', report.id, { name });
  return json({ report }, { status: 201 });
});
