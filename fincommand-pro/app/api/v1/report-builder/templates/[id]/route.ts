import type { NextRequest } from 'next/server';
import { authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { logAudit } from '@/lib/audit/audit';
import {
  loadTemplate, loadLinesForTemplate, loadLineLedgerMap, renameTemplate, deleteTemplate,
} from '@/lib/db/queries/report-builder';

export const runtime = 'nodejs';

/** GET: one template's full structure (lines + ledger mappings) — feeds the Structure Editor and Ledger Mapper screens. */
export const GET = withErrorHandling(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const user = await authenticate(req);
  const { id } = await params;
  const template = await loadTemplate(user.company_id, id);
  if (!template) return json({ error: 'Template not found' }, { status: 404 });

  const [lines, lineLedgerMap] = await Promise.all([
    loadLinesForTemplate(id),
    loadLineLedgerMap(id),
  ]);
  return json({ template, lines, lineLedgerMap });
});

export const PUT = withErrorHandling(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.isCFO);
  const { id } = await params;

  const body = await req.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  if (!name) return json({ error: 'name is required' }, { status: 400 });

  await renameTemplate(user.company_id, id, name);
  logAudit(req, user, 'report_builder.template.rename', 'report_template', id, { name });
  return json({ message: 'Renamed' });
});

export const DELETE = withErrorHandling(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.isCFO);
  const { id } = await params;

  await deleteTemplate(user.company_id, id);
  logAudit(req, user, 'report_builder.template.delete', 'report_template', id);
  return json({ message: 'Deleted' });
});
