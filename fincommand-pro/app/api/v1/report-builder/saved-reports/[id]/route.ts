import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { logAudit } from '@/lib/audit/audit';
import { updateSavedReport, deleteSavedReport } from '@/lib/db/queries/report-builder';

export const runtime = 'nodejs';

export const PUT = withErrorHandling(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const user = await authenticate(req);
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  await updateSavedReport(user.company_id, id, {
    name: typeof body.name === 'string' ? body.name.trim() : undefined,
    monthIndices: Array.isArray(body.monthIndices) ? body.monthIndices.map(Number) : undefined,
    showPercent: typeof body.showPercent === 'boolean' ? body.showPercent : undefined,
    financialYearId: typeof body.financialYearId === 'string' ? body.financialYearId : undefined,
  });
  logAudit(req, user, 'report_builder.saved_report.update', 'report_saved_report', id);
  return json({ message: 'Updated' });
});

export const DELETE = withErrorHandling(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const user = await authenticate(req);
  const { id } = await params;
  await deleteSavedReport(user.company_id, id);
  logAudit(req, user, 'report_builder.saved_report.delete', 'report_saved_report', id);
  return json({ message: 'Deleted' });
});
