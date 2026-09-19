import type { NextRequest } from 'next/server';
import { authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { logAudit } from '@/lib/audit/audit';
import { invalidateReportCache } from '@/lib/cache/report-cache';
import {
  getCustomMetricVersion, loadCustomMetricDefinitions, saveCustomMetricVersioned,
} from '@/lib/db/queries/custom-metrics';
import { validateCustomMetricDefinition, toSnapshot } from '@/lib/financial/custom-metric-engine';

export const runtime = 'nodejs';

/**
 * POST — restores a custom metric to an earlier version. Never rewrites
 * history: the restore is saved as a NEW version whose content equals the
 * chosen one. The old snapshot is re-validated against the company's
 * CURRENT metrics first (a metric it referenced may since have been deleted,
 * or restoring it could now create a cycle) — a restore that would produce
 * an invalid definition is refused, not applied. `expectedVersion` guards
 * against restoring over a change someone else just made.
 */
export const POST = withErrorHandling(async (
  req: NextRequest, { params }: { params: Promise<{ key: string; version: string }> },
) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.canWrite);
  const { key, version: versionParam } = await params;
  const version = Number(versionParam);
  if (!Number.isInteger(version) || version < 1) return json({ error: 'Invalid version' }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const expectedVersion = Number(body.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return json({ error: 'expectedVersion (the version currently shown) is required' }, { status: 400 });
  }

  const restored = await getCustomMetricVersion(user.company_id, key, version);
  if (!restored) return json({ error: `Version ${version} of this metric was not found` }, { status: 404 });

  const existing = await loadCustomMetricDefinitions(user.company_id);
  const validation = validateCustomMetricDefinition(restored, existing);
  if (!validation.ok) {
    return json({ error: `Version ${version} can't be restored as it stands today: ${validation.error}` }, { status: 409 });
  }

  const note = `Restored from version ${version}`;
  const result = await saveCustomMetricVersioned(
    user.company_id, { id: user.id, name: user.name }, validation.definition, expectedVersion, note,
  );
  if (!result.changedFields.length) {
    return json({ metric: result.metric, changedFields: [], message: `Version ${version} is identical to the current definition — nothing to restore.` });
  }
  invalidateReportCache(user.company_id);
  logAudit(
    req, user, 'custom_metric.restore', 'custom_metric_definition', result.metric.id ?? null,
    { key, restored_version: version, new_version: result.metric.version, changed_fields: result.changedFields },
    result.previous ? { ...toSnapshot(result.previous) } : null,
    { ...toSnapshot(result.metric) },
  );
  return json({ metric: result.metric, changedFields: result.changedFields });
});
