import type { NextRequest } from 'next/server';
import { authenticate, type AuthUser } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { logAudit } from '@/lib/audit/audit';
import { loadPersonalLayout, loadCompanyDefaultLayout, saveLayout, deletePersonalLayout } from '@/lib/db/queries/dashboard-builder';
import { loadCustomMetrics } from '@/lib/db/queries/custom-metrics';
import { resolveTabKey } from '@/lib/db/queries/custom-tabs';
import { parseWidgetsInput, type TabKey } from '@/lib/financial/dashboard-builder-engine';
import { SYSTEM_DEFAULT_WIDGETS } from '@/lib/dashboard-builder/default-layout';

export const runtime = 'nodejs';

type TabKeyResult = { error: Response } | { tabKey: TabKey };

/**
 * Resolves the tab_key query param against the 13 fixed tabs (no DB hit) or
 * this company's own custom tabs the caller may see (see resolveTabKey() in
 * lib/db/queries/custom-tabs.ts) — a custom-* key that was never created, or
 * that isn't shared with the caller, is rejected here exactly like an
 * unrecognized fixed tab, so sharing is enforced on every layout read/write.
 */
async function requireTabKey(req: NextRequest, user: AuthUser): Promise<TabKeyResult> {
  const tabKey = await resolveTabKey(user.company_id, req.nextUrl.searchParams.get('tab_key'), user);
  if (!tabKey) {
    return { error: json({ error: 'tab_key query parameter is required and must be a recognized tab' }, { status: 400 }) };
  }
  return { tabKey };
}

/**
 * GET — one tab's 3-tier fallback: the caller's own saved layout for this
 * tab, else their company's shared default for this tab (set via PUT
 * /dashboard-layout/company-default), else a hardcoded starter layout for
 * `tab_key='my-dashboard'` only — every other tab_key has a real fixed view
 * of its own to fall back to instead (the frontend, not this route, owns
 * that decision: CustomizableTabPanel renders its `fixedView` prop whenever
 * this endpoint reports no saved customization). `source` tells the caller
 * which tier it got, so it can disclose "you're viewing a starter/default
 * layout" rather than silently implying the user already customized it.
 */
export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  const tabKeyResult = await requireTabKey(req, user);
  if ('error' in tabKeyResult) return tabKeyResult.error;
  const { tabKey } = tabKeyResult;

  const personal = await loadPersonalLayout(user.company_id, user.id, tabKey);
  if (personal) {
    return json({ source: 'personal', layout_cols: personal.layoutCols, row_height_px: personal.rowHeightPx, widgets: personal.widgets });
  }
  const companyDefault = await loadCompanyDefaultLayout(user.company_id, tabKey);
  if (companyDefault) {
    return json({ source: 'company_default', layout_cols: companyDefault.layoutCols, row_height_px: companyDefault.rowHeightPx, widgets: companyDefault.widgets });
  }
  if (tabKey === 'my-dashboard') {
    return json({ source: 'system_default', layout_cols: 12, row_height_px: 40, widgets: SYSTEM_DEFAULT_WIDGETS });
  }
  return json({ source: 'none', layout_cols: 12, row_height_px: 40, widgets: [] });
});

/**
 * PUT — replaces the caller's OWN personal layout for this tab. Any
 * authenticated role may do this (it's a personal display preference, not a
 * financial-data mutation) — unlike the company-default endpoint, which is
 * role-gated.
 */
export const PUT = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  const tabKeyResult = await requireTabKey(req, user);
  if ('error' in tabKeyResult) return tabKeyResult.error;
  const { tabKey } = tabKeyResult;

  const body = await req.json().catch(() => ({}));
  const customMetricKeys = new Set((await loadCustomMetrics(user.company_id)).map((m) => m.key));
  const parsed = parseWidgetsInput(body.widgets, 12, customMetricKeys);
  if ('error' in parsed) return json({ error: parsed.error }, { status: 400 });

  const layoutId = await saveLayout(user.company_id, user.id, tabKey, parsed.widgets);
  logAudit(req, user, 'dashboard_layout.save', 'dashboard_layout', layoutId, { widget_count: parsed.widgets.length, tab_key: tabKey });

  const saved = await loadPersonalLayout(user.company_id, user.id, tabKey);
  return json({ source: 'personal', layout_cols: saved!.layoutCols, row_height_px: saved!.rowHeightPx, widgets: saved!.widgets });
});

/** DELETE — resets the caller's personal layout for this tab, reverting them to the company/system/fixed default. */
export const DELETE = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  const tabKeyResult = await requireTabKey(req, user);
  if ('error' in tabKeyResult) return tabKeyResult.error;
  const { tabKey } = tabKeyResult;

  await deletePersonalLayout(user.company_id, user.id, tabKey);
  logAudit(req, user, 'dashboard_layout.reset', 'dashboard_layout', user.id, { tab_key: tabKey });
  return json({ message: 'This tab has been reset to the default layout.' });
});
