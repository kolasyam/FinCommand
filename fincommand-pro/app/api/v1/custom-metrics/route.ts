import type { NextRequest } from 'next/server';
import { authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { logAudit } from '@/lib/audit/audit';
import { invalidateReportCache } from '@/lib/cache/report-cache';
import { loadCustomMetrics, loadCustomMetricDefinitions, saveCustomMetricVersioned } from '@/lib/db/queries/custom-metrics';
import {
  validateCustomMetricDefinition, toSnapshot,
  type CustomMetricDefinition, type FormulaExpr, type MetricComparison,
} from '@/lib/financial/custom-metric-engine';
import type { LedgerMetricSpec } from '@/lib/financial/tb-engine';

export const runtime = 'nodejs';

/** GET — every custom metric this company has defined, with usage counts and formula dependents. Any authenticated role may read it (needed to render widgets). */
export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  const metrics = await loadCustomMetrics(user.company_id);
  return json({ metrics });
});

/** Maps a request body onto a candidate definition — every field is re-validated by validateCustomMetricDefinition(). */
function candidateFromBody(body: Record<string, unknown>): CustomMetricDefinition {
  const targetValue = body.targetValue != null && body.targetValue !== '' ? Number(body.targetValue) : null;
  const direction = body.thresholdDirection === 'higher_is_better' || body.thresholdDirection === 'lower_is_better'
    ? body.thresholdDirection : null;
  const warnValue = body.warnValue != null && body.warnValue !== '' ? Number(body.warnValue) : null;
  return {
    key: typeof body.metricKey === 'string' ? body.metricKey.trim() : '',
    label: typeof body.label === 'string' ? body.label : '',
    description: typeof body.description === 'string' ? body.description : null,
    kind: body.kind === 'ledger' ? 'ledger' : 'formula',
    valueType: body.valueType as CustomMetricDefinition['valueType'],
    decimals: Number(body.decimals),
    expression: (body.expression ?? null) as FormulaExpr | null,
    ledgerSpec: (body.ledgerSpec ?? null) as LedgerMetricSpec | null,
    thresholds: targetValue != null || direction != null
      ? { target: targetValue as number, direction: direction as 'higher_is_better', ...(warnValue != null ? { warn: warnValue } : {}) }
      : null,
    // Anything but the three known values is rejected by validateCustomMetricDefinition().
    comparison: body.comparison == null ? 'prior_year' : (body.comparison as MetricComparison),
  };
}

/**
 * POST — creates (no `expectedVersion`) or updates (`expectedVersion` = the
 * version the editor loaded) a custom metric. Role-gated to
 * ROLE_SETS.canWrite (admin/cfo/manager) — an org-wide definition, like a
 * ledger_master mapping. Every save writes a new row to
 * custom_metric_versions (see saveCustomMetricVersioned()); a create that
 * collides with an existing key, or an update from a stale version, is a
 * 409 rather than a silent overwrite.
 */
export const POST = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.canWrite);

  const body = await req.json().catch(() => ({}));
  const candidate = candidateFromBody(body);
  if (candidate.thresholds && (!Number.isFinite(candidate.thresholds.target) || !candidate.thresholds.direction)) {
    return json({ error: 'targetValue and thresholdDirection must be set together, or not at all' }, { status: 400 });
  }
  if (!candidate.thresholds && body.warnValue != null && body.warnValue !== '') {
    return json({ error: 'A warning level needs a target' }, { status: 400 });
  }
  const expectedVersion = body.expectedVersion == null ? null : Number(body.expectedVersion);
  if (expectedVersion != null && (!Number.isInteger(expectedVersion) || expectedVersion < 1)) {
    return json({ error: 'expectedVersion must be a positive whole number' }, { status: 400 });
  }
  const changeNote = typeof body.changeNote === 'string' && body.changeNote.trim() ? body.changeNote.trim().slice(0, 300) : null;

  const existing = await loadCustomMetricDefinitions(user.company_id);
  const validation = validateCustomMetricDefinition(candidate, existing);
  if (!validation.ok) return json({ error: validation.error }, { status: 400 });

  const result = await saveCustomMetricVersioned(
    user.company_id, { id: user.id, name: user.name }, validation.definition, expectedVersion, changeNote,
  );
  // Ledger-metric values are computed inside the cached /reports/all bundle,
  // and formula metrics may now reference them — drop this company's cached
  // bundles so the next load reflects the new definition.
  invalidateReportCache(user.company_id);

  if (result.changedFields.length) {
    logAudit(
      req, user, result.previous ? 'custom_metric.update' : 'custom_metric.create', 'custom_metric_definition', result.metric.id ?? null,
      { key: result.metric.key, label: result.metric.label, version: result.metric.version, changed_fields: result.changedFields, change_note: changeNote },
      result.previous ? { ...toSnapshot(result.previous) } : null,
      { ...toSnapshot(result.metric) },
    );
  }
  return json({ metric: result.metric, changedFields: result.changedFields }, { status: result.previous ? 200 : 201 });
});
