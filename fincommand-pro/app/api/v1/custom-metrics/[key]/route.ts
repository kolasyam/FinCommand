import type { NextRequest } from 'next/server';
import { authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { logAudit } from '@/lib/audit/audit';
import { invalidateReportCache } from '@/lib/cache/report-cache';
import { deleteCustomMetric, countMetricUsage, loadCustomMetricDefinitions } from '@/lib/db/queries/custom-metrics';
import { findDependents, toSnapshot } from '@/lib/financial/custom-metric-engine';

export const runtime = 'nodejs';

/**
 * DELETE — removes a custom metric definition (and its version history).
 * Role-gated to ROLE_SETS.canWrite. Refused with 409 while another custom
 * metric's formula references it — deleting it would silently break those
 * formulas. Widgets still bound to it afterward simply show "no data"
 * (resolveAnyMetric() returns null for an unknown key) — the UI surfaces
 * that widget count before the user confirms.
 */
export const DELETE = withErrorHandling(async (req: NextRequest, { params }: { params: Promise<{ key: string }> }) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.canWrite);
  const { key } = await params;

  const defs = await loadCustomMetricDefinitions(user.company_id);
  const target = defs.find((d) => d.key === key);
  if (!target) return json({ error: 'Custom metric not found' }, { status: 404 });

  const dependents = findDependents(key, defs);
  if (dependents.length) {
    const names = dependents.map((k) => `"${defs.find((d) => d.key === k)?.label ?? k}"`).join(', ');
    return json({ error: `"${target.label}" is used in the formula of ${names}. Remove it from ${dependents.length === 1 ? 'that metric' : 'those metrics'} first.`, dependents }, { status: 409 });
  }

  const usageCount = await countMetricUsage(user.company_id, key);
  const deleted = await deleteCustomMetric(user.company_id, key);
  if (!deleted) return json({ error: 'Custom metric not found' }, { status: 404 });
  invalidateReportCache(user.company_id);

  logAudit(req, user, 'custom_metric.delete', 'custom_metric_definition', deleted.id ?? null,
    { key, label: deleted.label, usage_count: usageCount }, { ...toSnapshot(deleted) }, null);
  return json({ message: 'Custom metric deleted.', usageCount });
});
