import { query, withTransaction } from '@/lib/db/neon';
import type { PoolClient } from 'pg';
import {
  findDependents, toSnapshot, fromSnapshot, diffSnapshots,
  type CustomMetricDefinition, type CustomMetricListItem, type CustomMetricSnapshot, type FormulaExpr, type CustomMetricKind,
  type MetricComparison,
} from '@/lib/financial/custom-metric-engine';
import type { ValueType, MetricThresholds } from '@/lib/financial/dashboard-builder-engine';
import type { LedgerMetricSpec } from '@/lib/financial/tb-engine';

interface CustomMetricRow {
  id: string;
  metric_key: string;
  label: string;
  description: string | null;
  definition_kind: CustomMetricKind;
  value_type: ValueType;
  decimals: number;
  expression: FormulaExpr | null;
  ledger_spec: LedgerMetricSpec | null;
  target_value: string | number | null;
  threshold_direction: 'higher_is_better' | 'lower_is_better' | null;
  warn_value: string | number | null;
  comparison: MetricComparison | null;
  version: number;
  updated_at: string | null;
}

const COLUMNS = `id, metric_key, label, description, definition_kind, value_type, decimals, expression, ledger_spec,
  target_value, threshold_direction, warn_value, comparison, version, updated_at`;

function toDefinition(r: CustomMetricRow): CustomMetricDefinition {
  const target = r.target_value != null ? parseFloat(String(r.target_value)) : null;
  const warn = r.warn_value != null ? parseFloat(String(r.warn_value)) : null;
  const thresholds: MetricThresholds | null = target != null && Number.isFinite(target) && r.threshold_direction
    ? { direction: r.threshold_direction, target, ...(warn != null && Number.isFinite(warn) ? { warn } : {}) }
    : null;
  const kind: CustomMetricKind = r.definition_kind === 'ledger' ? 'ledger' : 'formula';
  return {
    id: r.id,
    key: r.metric_key,
    label: r.label,
    description: r.description,
    kind,
    valueType: r.value_type,
    decimals: r.decimals,
    expression: kind === 'formula' ? r.expression : null,
    ledgerSpec: kind === 'ledger' ? r.ledger_spec : null,
    thresholds,
    comparison: r.comparison ?? 'prior_year',
    version: r.version,
  };
}

/** Every custom metric definition this company has — the lean form, for evaluation and validation (reports/all, save-time graph checks). */
export async function loadCustomMetricDefinitions(companyId: string): Promise<CustomMetricDefinition[]> {
  const { rows } = await query<CustomMetricRow>(
    `SELECT ${COLUMNS} FROM custom_metric_definitions WHERE company_id=$1 ORDER BY label`,
    [companyId]
  );
  return rows.map(toDefinition);
}

/**
 * Every custom metric this company has defined, with how many dashboard
 * widgets bind to each (a LATERAL scan of dashboard_widgets.series — stored
 * camelCase `metricKey`, written by parseWidgetsInput()) and which other
 * custom metrics' formulas depend on it. Empty [] (never an error) for a
 * company with none.
 */
export async function loadCustomMetrics(companyId: string): Promise<CustomMetricListItem[]> {
  const { rows } = await query<CustomMetricRow & { usage_count: number }>(
    `SELECT cmd.id, cmd.metric_key, cmd.label, cmd.description, cmd.definition_kind, cmd.value_type, cmd.decimals,
            cmd.expression, cmd.ledger_spec, cmd.target_value, cmd.threshold_direction, cmd.warn_value, cmd.comparison,
            cmd.version, cmd.updated_at,
            COALESCE(usage.usage_count, 0)::int AS usage_count
     FROM custom_metric_definitions cmd
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS usage_count
       FROM dashboard_widgets dw
       JOIN dashboard_layouts dl ON dl.id = dw.layout_id
       WHERE dl.company_id = cmd.company_id
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(dw.series) elem WHERE elem->>'metricKey' = cmd.metric_key)
     ) usage ON true
     WHERE cmd.company_id=$1 ORDER BY cmd.label`,
    [companyId]
  );
  const defs = rows.map(toDefinition);
  return rows.map((r, i) => ({
    ...defs[i],
    usageCount: r.usage_count,
    usedByMetrics: findDependents(r.metric_key, defs),
    updatedAt: r.updated_at,
  }));
}

export async function getCustomMetricByKey(companyId: string, metricKey: string): Promise<CustomMetricDefinition | null> {
  const { rows } = await query<CustomMetricRow>(
    `SELECT ${COLUMNS} FROM custom_metric_definitions WHERE company_id=$1 AND metric_key=$2`,
    [companyId, metricKey]
  );
  return rows[0] ? toDefinition(rows[0]) : null;
}

/** Thrown for a create that collides with an existing key, or an update whose expectedVersion is stale (someone else saved in between). `status` is read by withErrorHandling(), so it surfaces as HTTP 409 with this message. */
export class CustomMetricConflictError extends Error {
  status = 409;
  constructor(message: string) { super(message); this.name = 'CustomMetricConflictError'; }
}
export class CustomMetricNotFoundError extends Error {
  status = 404;
  constructor(message: string) { super(message); this.name = 'CustomMetricNotFoundError'; }
}

export interface SaveActor { id: string; name: string }

async function insertVersionRow(
  client: PoolClient, metricId: string, companyId: string, version: number,
  snapshot: CustomMetricSnapshot, changedFields: string[], note: string | null, actor: SaveActor,
): Promise<void> {
  await client.query(
    `INSERT INTO custom_metric_versions
       (metric_id, company_id, version, snapshot, change_note, changed_fields, changed_by, changed_by_name)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,$8)`,
    [metricId, companyId, version, JSON.stringify(snapshot), note, JSON.stringify(changedFields), actor.id, actor.name]
  );
}

function rowParams(def: CustomMetricDefinition) {
  const snap = toSnapshot(def);
  return {
    snap,
    values: [
      snap.label, snap.description, snap.kind, snap.valueType, snap.decimals,
      snap.expression ? JSON.stringify(snap.expression) : null,
      snap.ledgerSpec ? JSON.stringify(snap.ledgerSpec) : null,
      snap.targetValue, snap.thresholdDirection, snap.warnValue ?? null, snap.comparison ?? 'prior_year',
    ],
  };
}

export interface SaveCustomMetricResult {
  metric: CustomMetricDefinition;
  previous: CustomMetricDefinition | null;
  changedFields: string[];
}

/**
 * Creates (expectedVersion === null) or updates (expectedVersion = the
 * version the editor loaded) one custom metric, and records the resulting
 * state as a new row in custom_metric_versions — all in one transaction, so
 * a definition and its history can never disagree.
 *
 * - Create refuses an existing key (409) instead of silently overwriting it
 *   — the previous upsert-by-key let a "new" metric whose auto-generated key
 *   happened to match an existing one replace that metric without warning.
 * - Update locks the row and refuses a stale expectedVersion (409), so two
 *   people editing the same metric can't silently overwrite each other.
 * - A save that changes nothing records no new version.
 */
export async function saveCustomMetricVersioned(
  companyId: string, actor: SaveActor, def: CustomMetricDefinition,
  expectedVersion: number | null, changeNote: string | null,
): Promise<SaveCustomMetricResult> {
  return withTransaction(async (client) => {
    const { rows: existingRows } = await client.query<CustomMetricRow>(
      `SELECT ${COLUMNS} FROM custom_metric_definitions WHERE company_id=$1 AND metric_key=$2 FOR UPDATE`,
      [companyId, def.key]
    );
    const existing = existingRows[0] ? toDefinition(existingRows[0]) : null;
    const { snap, values } = rowParams(def);

    if (expectedVersion == null) {
      if (existing) throw new CustomMetricConflictError(`A custom metric with the key "${def.key}" already exists — choose a different name or key.`);
      const { rows } = await client.query<CustomMetricRow>(
        `INSERT INTO custom_metric_definitions
           (company_id, metric_key, label, description, definition_kind, value_type, decimals, expression, ledger_spec,
            target_value, threshold_direction, warn_value, comparison, version, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,1,$14,$14)
         RETURNING ${COLUMNS}`,
        [companyId, def.key, ...values, actor.id]
      );
      const saved = toDefinition(rows[0]!);
      await insertVersionRow(client, saved.id!, companyId, 1, snap, ['created'], changeNote, actor);
      return { metric: saved, previous: null, changedFields: ['created'] };
    }

    if (!existing) throw new CustomMetricNotFoundError(`Custom metric "${def.key}" no longer exists.`);
    if (existing.version !== expectedVersion) {
      throw new CustomMetricConflictError(
        `"${existing.label}" was changed by someone else (now version ${existing.version}, you edited version ${expectedVersion}). Close and reopen it to see the latest before saving.`
      );
    }
    const changedFields = diffSnapshots(toSnapshot(existing), snap);
    if (changedFields.length === 0) return { metric: existing, previous: existing, changedFields };

    const nextVersion = existing.version! + 1;
    const { rows } = await client.query<CustomMetricRow>(
      `UPDATE custom_metric_definitions SET
         label=$3, description=$4, definition_kind=$5, value_type=$6, decimals=$7,
         expression=$8::jsonb, ledger_spec=$9::jsonb, target_value=$10, threshold_direction=$11,
         warn_value=$12, comparison=$13, version=$14, updated_by=$15, updated_at=NOW()
       WHERE company_id=$1 AND metric_key=$2
       RETURNING ${COLUMNS}`,
      [companyId, def.key, ...values, nextVersion, actor.id]
    );
    const saved = toDefinition(rows[0]!);
    await insertVersionRow(client, saved.id!, companyId, nextVersion, snap, changedFields, changeNote, actor);
    return { metric: saved, previous: existing, changedFields };
  });
}

export interface CustomMetricVersion {
  version: number;
  snapshot: CustomMetricSnapshot;
  changeNote: string | null;
  changedFields: string[];
  changedByName: string | null;
  createdAt: string;
}

/** Full history of one metric, newest first. */
export async function listCustomMetricVersions(companyId: string, metricKey: string): Promise<CustomMetricVersion[] | null> {
  const metric = await getCustomMetricByKey(companyId, metricKey);
  if (!metric) return null;
  const { rows } = await query<{
    version: number; snapshot: CustomMetricSnapshot; change_note: string | null;
    changed_fields: string[]; changed_by_name: string | null; created_at: string;
  }>(
    `SELECT version, snapshot, change_note, changed_fields, changed_by_name, created_at
     FROM custom_metric_versions WHERE company_id=$1 AND metric_id=$2 ORDER BY version DESC`,
    [companyId, metric.id]
  );
  return rows.map((r) => ({
    version: r.version, snapshot: r.snapshot, changeNote: r.change_note,
    changedFields: r.changed_fields ?? [], changedByName: r.changed_by_name, createdAt: r.created_at,
  }));
}

/** One historical version's snapshot as a definition (for restore validation), or null if that metric/version doesn't exist. */
export async function getCustomMetricVersion(companyId: string, metricKey: string, version: number): Promise<CustomMetricDefinition | null> {
  const { rows } = await query<{ snapshot: CustomMetricSnapshot }>(
    `SELECT v.snapshot FROM custom_metric_versions v
     JOIN custom_metric_definitions d ON d.id = v.metric_id
     WHERE d.company_id=$1 AND d.metric_key=$2 AND v.version=$3`,
    [companyId, metricKey, version]
  );
  if (!rows[0]) return null;
  // The key is immutable, so a restored definition always keeps the live key.
  return { ...fromSnapshot(rows[0].snapshot), key: metricKey };
}

/** How many dashboard widgets (any layout/tab/user, company-wide) currently bind to this metric key. */
export async function countMetricUsage(companyId: string, metricKey: string): Promise<number> {
  const { rows } = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM dashboard_widgets dw
     JOIN dashboard_layouts dl ON dl.id = dw.layout_id
     WHERE dl.company_id=$1
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(dw.series) elem WHERE elem->>'metricKey' = $2)`,
    [companyId, metricKey]
  );
  return parseInt(rows[0]?.count ?? '0', 10);
}

/**
 * Deletes a custom metric (its version rows cascade). Widgets still bound to
 * the key show "no data" afterward (never a crash). The route refuses the
 * delete while another custom metric's formula still references this one —
 * see findDependents().
 */
export async function deleteCustomMetric(companyId: string, metricKey: string): Promise<CustomMetricDefinition | null> {
  const { rows } = await query<CustomMetricRow>(
    `DELETE FROM custom_metric_definitions WHERE company_id=$1 AND metric_key=$2 RETURNING ${COLUMNS}`,
    [companyId, metricKey]
  );
  return rows[0] ? toDefinition(rows[0]) : null;
}
