'use client';

/**
 * Thin apiFetch() wrappers for the tab-customization builder's own
 * endpoints — kept separate from the main dashboard bundle
 * (lib/dashboard/api-client.ts's apiFetch), same reasoning
 * lib/dashboard/report-builder-api.ts already follows: a tab layout is
 * company-wide/user-wide state, not tied to the global PeriodBar's
 * FY+period selection the way `bundle` is.
 */
import { apiFetch } from './api-client';
import type { DashboardWidget, TabKey } from '@/lib/financial/dashboard-builder-engine';
import type {
  CustomMetricDefinition, CustomMetricListItem, CustomMetricSnapshot, CustomMetricKind, FormulaExpr,
} from '@/lib/financial/custom-metric-engine';
import type { LedgerMetricSpec } from '@/lib/financial/tb-engine';

export interface DashboardLayoutResponse {
  source: 'personal' | 'company_default' | 'system_default' | 'none';
  layout_cols: number;
  row_height_px: number;
  widgets: DashboardWidget[];
}

export function fetchTabLayout(tabKey: TabKey) {
  return apiFetch<DashboardLayoutResponse>(`/dashboard-layout?tab_key=${tabKey}`);
}

/** One round trip resolving every customizable tab's state — see TabCustomizationsContext, the only intended caller. */
export function fetchAllTabLayouts() {
  return apiFetch<Record<TabKey, DashboardLayoutResponse>>('/dashboard-layout/all');
}

export function saveTabLayout(tabKey: TabKey, widgets: DashboardWidget[]) {
  return apiFetch<DashboardLayoutResponse>(`/dashboard-layout?tab_key=${tabKey}`, {
    method: 'PUT',
    body: JSON.stringify({ widgets }),
  });
}

export function resetTabLayout(tabKey: TabKey) {
  return apiFetch<{ message: string }>(`/dashboard-layout?tab_key=${tabKey}`, { method: 'DELETE' });
}

/** admin/cfo/manager only — server re-checks the role regardless. */
export function saveCompanyDefaultTabLayout(tabKey: TabKey, widgets: DashboardWidget[]) {
  return apiFetch<DashboardLayoutResponse>(`/dashboard-layout/company-default?tab_key=${tabKey}`, {
    method: 'PUT',
    body: JSON.stringify({ widgets }),
  });
}

// ── Custom metrics ─────────────────────────────────────────────────────────

export function fetchCustomMetrics() {
  return apiFetch<{ metrics: CustomMetricListItem[] }>('/custom-metrics');
}

export interface SaveCustomMetricInput {
  metricKey: string;
  label: string;
  description?: string | null;
  kind: CustomMetricKind;
  valueType: CustomMetricDefinition['valueType'];
  decimals: number;
  expression: FormulaExpr | null;
  ledgerSpec: LedgerMetricSpec | null;
  targetValue: number | null;
  thresholdDirection: 'higher_is_better' | 'lower_is_better' | null;
  /** Optional early-warning level on the bad side of the target (requires a target). */
  warnValue?: number | null;
  /** What the change figure compares against (default prior_year). */
  comparison?: 'prior_year' | 'prior_period' | 'none';
  /** The version the editor loaded — omit to CREATE (the server refuses an existing key instead of overwriting it). */
  expectedVersion?: number;
  /** Optional "what changed" note stored with the new version. */
  changeNote?: string;
}

/** admin/cfo/manager only — the server re-checks the role. Create (no expectedVersion) or update (expectedVersion = loaded version); a stale version is a 409. */
export function saveCustomMetric(input: SaveCustomMetricInput) {
  return apiFetch<{ metric: CustomMetricDefinition; changedFields: string[] }>('/custom-metrics', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deleteCustomMetric(metricKey: string) {
  return apiFetch<{ message: string; usageCount: number }>(`/custom-metrics/${encodeURIComponent(metricKey)}`, { method: 'DELETE' });
}

export interface CustomMetricVersionDTO {
  version: number;
  snapshot: CustomMetricSnapshot;
  changeNote: string | null;
  changedFields: string[];
  changedByName: string | null;
  createdAt: string;
}

export function fetchCustomMetricVersions(metricKey: string) {
  return apiFetch<{ versions: CustomMetricVersionDTO[] }>(`/custom-metrics/${encodeURIComponent(metricKey)}/versions`);
}

/** Restores `version` as a NEW version. `expectedVersion` = the version currently shown (409 if someone else changed it meanwhile). */
export function restoreCustomMetricVersion(metricKey: string, version: number, expectedVersion: number) {
  return apiFetch<{ metric: CustomMetricDefinition; changedFields: string[]; message?: string }>(
    `/custom-metrics/${encodeURIComponent(metricKey)}/versions/${version}/restore`,
    { method: 'POST', body: JSON.stringify({ expectedVersion }) },
  );
}

export interface LedgerMetricPreview {
  /** null when an average/smallest/largest has no ledger with activity to work from. */
  value: number | null;
  previous: number | null;
  trend: { label: string; value: number }[];
  matchedCount: number;
  matchedLedgers: { label: string; value: number }[];
  periodLabel: string;
}

/** Live value of an UNSAVED ledger metric for the dashboard's current FY/period — nothing is stored. */
export function previewLedgerMetric(input: {
  ledgerSpec: LedgerMetricSpec; fyId: string; periodType: string; period: string | null; yearType: string;
  comparison?: 'prior_year' | 'prior_period' | 'none';
}) {
  return apiFetch<LedgerMetricPreview>('/custom-metrics/preview', {
    method: 'POST',
    body: JSON.stringify({
      ledgerSpec: input.ledgerSpec, fy_id: input.fyId, period_type: input.periodType,
      period: input.period ?? undefined, year_type: input.yearType, comparison: input.comparison,
    }),
  });
}
