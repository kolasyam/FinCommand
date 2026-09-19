import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { loadAllTabStates } from '@/lib/db/queries/dashboard-builder';
import { loadCustomTabs } from '@/lib/db/queries/custom-tabs';
import { TAB_KEYS, type TabKey } from '@/lib/financial/dashboard-builder-engine';
import { SYSTEM_DEFAULT_WIDGETS } from '@/lib/dashboard-builder/default-layout';

export const runtime = 'nodejs';

/**
 * GET — resolves EVERY tab's state in one round trip (same 3-tier fallback
 * as GET /api/v1/dashboard-layout, run once per tab_key instead of requiring
 * a separate request per tab). Exists specifically so TabCustomizationsContext
 * can fetch once per session and switching tabs costs zero additional
 * network round-trips.
 *
 * Walks TAB_KEYS (the 13 fixed tabs) UNION the custom tabs shared with the
 * caller (loadCustomTabs filters by sharing) — loadAllTabStates itself already returns a row for ANY
 * tab_key the company/user has (it's not filtered to TAB_KEYS), so the
 * previous version of this route silently dropped a saved custom-tab layout
 * from the response purely because this loop never walked past the fixed 13.
 */
export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  const [states, customTabs] = await Promise.all([
    loadAllTabStates(user.company_id, user.id),
    loadCustomTabs(user.company_id, user),
  ]);

  const result: Record<TabKey, { source: string; layout_cols: number; row_height_px: number; widgets: unknown[] }> = {};

  for (const tabKey of TAB_KEYS) {
    const state = states[tabKey];
    if (state) {
      result[tabKey] = { source: state.source, layout_cols: state.layoutCols, row_height_px: state.rowHeightPx, widgets: state.widgets };
    } else if (tabKey === 'my-dashboard') {
      result[tabKey] = { source: 'system_default', layout_cols: 12, row_height_px: 40, widgets: SYSTEM_DEFAULT_WIDGETS };
    } else {
      result[tabKey] = { source: 'none', layout_cols: 12, row_height_px: 40, widgets: [] };
    }
  }
  for (const ct of customTabs) {
    const state = states[ct.tabKey];
    result[ct.tabKey] = state
      ? { source: state.source, layout_cols: state.layoutCols, row_height_px: state.rowHeightPx, widgets: state.widgets }
      : { source: 'none', layout_cols: 12, row_height_px: 40, widgets: [] };
  }
  return json(result);
});
