import type { NextRequest } from 'next/server';
import { authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { logAudit } from '@/lib/audit/audit';
import { loadCompanyDefaultLayout, saveLayout } from '@/lib/db/queries/dashboard-builder';
import { loadCustomMetrics } from '@/lib/db/queries/custom-metrics';
import { resolveTabKey } from '@/lib/db/queries/custom-tabs';
import { parseWidgetsInput } from '@/lib/financial/dashboard-builder-engine';

export const runtime = 'nodejs';

/**
 * PUT — sets the company-wide starting layout for ONE tab that every user
 * without a personal layout of their own for that tab sees (see the 3-tier
 * fallback in GET /api/v1/dashboard-layout). Role-gated to
 * ROLE_SETS.canWrite (admin/cfo/manager) — the same set that gates Trial
 * Balance upload and financial-year creation — since this changes what
 * other users in the company see by default, unlike a personal layout save.
 */
export const PUT = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.canWrite);

  const tabKey = await resolveTabKey(user.company_id, req.nextUrl.searchParams.get('tab_key'), user);
  if (!tabKey) {
    return json({ error: 'tab_key query parameter is required and must be a recognized tab' }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const customMetricKeys = new Set((await loadCustomMetrics(user.company_id)).map((m) => m.key));
  const parsed = parseWidgetsInput(body.widgets, 12, customMetricKeys);
  if ('error' in parsed) return json({ error: parsed.error }, { status: 400 });

  const layoutId = await saveLayout(user.company_id, null, tabKey, parsed.widgets);
  logAudit(req, user, 'dashboard_layout.company_default.save', 'dashboard_layout', layoutId, { widget_count: parsed.widgets.length, tab_key: tabKey });

  const saved = await loadCompanyDefaultLayout(user.company_id, tabKey);
  return json({ source: 'company_default', layout_cols: saved!.layoutCols, row_height_px: saved!.rowHeightPx, widgets: saved!.widgets });
});
