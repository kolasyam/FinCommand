import { query, withTransaction } from '@/lib/db/neon';
import type { PoolClient } from 'pg';
import type { DashboardWidget, WidgetKind, TabKey } from '@/lib/financial/dashboard-builder-engine';

interface LayoutRow { id: string; layout_cols: number; row_height_px: number; }
interface WidgetRow {
  id: string; widget_type: string; title: string | null; subtitle: string | null;
  grid_x: number; grid_y: number; grid_w: number; grid_h: number;
  series: DashboardWidget['series']; viz_config: Record<string, unknown>; sequence: number;
}

function toWidget(r: WidgetRow): DashboardWidget {
  return {
    id: r.id,
    widgetType: r.widget_type as WidgetKind,
    title: r.title,
    subtitle: r.subtitle,
    gridX: r.grid_x, gridY: r.grid_y, gridW: r.grid_w, gridH: r.grid_h,
    series: r.series ?? [],
    vizConfig: r.viz_config ?? {},
    sequence: r.sequence,
  };
}

export interface LoadedLayout {
  layoutId: string;
  layoutCols: number;
  rowHeightPx: number;
  widgets: DashboardWidget[];
}

async function loadWidgets(layoutId: string): Promise<DashboardWidget[]> {
  const { rows } = await query<WidgetRow>(
    `SELECT id, widget_type, title, subtitle, grid_x, grid_y, grid_w, grid_h, series, viz_config, sequence
     FROM dashboard_widgets WHERE layout_id=$1 ORDER BY sequence`,
    [layoutId]
  );
  return rows.map(toWidget);
}

/** The signed-in user's own layout for one tab — null until they Save for the first time on that tab. */
export async function loadPersonalLayout(companyId: string, userId: string, tabKey: TabKey): Promise<LoadedLayout | null> {
  const { rows } = await query<LayoutRow>(
    `SELECT id, layout_cols, row_height_px FROM dashboard_layouts WHERE company_id=$1 AND user_id=$2 AND tab_key=$3`,
    [companyId, userId, tabKey]
  );
  if (!rows.length) return null;
  const widgets = await loadWidgets(rows[0].id);
  return { layoutId: rows[0].id, layoutCols: rows[0].layout_cols, rowHeightPx: rows[0].row_height_px, widgets };
}

/** The company-wide starting layout an admin/cfo/manager has configured for one tab (user_id IS NULL) — null until one is set. */
export async function loadCompanyDefaultLayout(companyId: string, tabKey: TabKey): Promise<LoadedLayout | null> {
  const { rows } = await query<LayoutRow>(
    `SELECT id, layout_cols, row_height_px FROM dashboard_layouts WHERE company_id=$1 AND user_id IS NULL AND tab_key=$2`,
    [companyId, tabKey]
  );
  if (!rows.length) return null;
  const widgets = await loadWidgets(rows[0].id);
  return { layoutId: rows[0].id, layoutCols: rows[0].layout_cols, rowHeightPx: rows[0].row_height_px, widgets };
}

export interface TabLayoutState extends LoadedLayout {
  source: 'personal' | 'company_default';
}

/**
 * One round-trip resolving every customizable tab's state for a user —
 * powers GET /api/v1/dashboard-layout/all so switching between the 8
 * customizable tabs (plus "My Dashboard") never fires a fresh per-tab
 * request. Only returns an entry for a tab_key that actually HAS a personal
 * or company-default row; a tab_key absent from the result has neither —
 * the API route decides the final fallback (SYSTEM_DEFAULT_WIDGETS for
 * 'my-dashboard', that tab's own fixed view for everything else), this
 * function stays a plain data loader with no tab-specific fallback policy
 * baked in.
 */
export async function loadAllTabStates(companyId: string, userId: string): Promise<Partial<Record<TabKey, TabLayoutState>>> {
  const { rows: layoutRows } = await query<LayoutRow & { user_id: string | null; tab_key: TabKey }>(
    `SELECT id, tab_key, user_id, layout_cols, row_height_px
     FROM dashboard_layouts WHERE company_id=$1 AND (user_id=$2 OR user_id IS NULL)`,
    [companyId, userId]
  );
  if (!layoutRows.length) return {};

  // Prefer the personal row over the company-default row when a tab has both.
  const byTab = new Map<TabKey, typeof layoutRows[number]>();
  for (const row of layoutRows) {
    const existing = byTab.get(row.tab_key);
    if (!existing || row.user_id !== null) byTab.set(row.tab_key, row);
  }

  const layoutIds = [...byTab.values()].map((r) => r.id);
  const { rows: widgetRows } = await query<WidgetRow & { layout_id: string }>(
    `SELECT layout_id, id, widget_type, title, subtitle, grid_x, grid_y, grid_w, grid_h, series, viz_config, sequence
     FROM dashboard_widgets WHERE layout_id = ANY($1::uuid[]) ORDER BY sequence`,
    [layoutIds]
  );
  const widgetsByLayout = new Map<string, DashboardWidget[]>();
  widgetRows.forEach((w) => {
    if (!widgetsByLayout.has(w.layout_id)) widgetsByLayout.set(w.layout_id, []);
    widgetsByLayout.get(w.layout_id)!.push(toWidget(w));
  });

  const result: Partial<Record<TabKey, TabLayoutState>> = {};
  byTab.forEach((row, tabKey) => {
    result[tabKey] = {
      source: row.user_id ? 'personal' : 'company_default',
      layoutId: row.id,
      layoutCols: row.layout_cols,
      rowHeightPx: row.row_height_px,
      widgets: widgetsByLayout.get(row.id) ?? [],
    };
  });
  return result;
}

/**
 * Bulk-inserts every widget for a layout in one multi-row INSERT — same
 * batching convention lib/db/queries/report-builder.ts's buildMultiRowInsert
 * already uses for this exact "replace a template's whole line/mapping set"
 * shape of write.
 */
async function insertWidgets(client: PoolClient, layoutId: string, widgets: DashboardWidget[]): Promise<void> {
  if (!widgets.length) return;
  const columns = ['layout_id', 'widget_type', 'title', 'subtitle', 'grid_x', 'grid_y', 'grid_w', 'grid_h', 'series', 'viz_config', 'sequence'];
  const jsonbColumns = new Set(['series', 'viz_config']);
  const params: unknown[] = [];
  let paramIdx = 1;
  const valueClauses = widgets.map((w, i) => {
    const values: unknown[] = [
      layoutId, w.widgetType, w.title, w.subtitle, w.gridX, w.gridY, w.gridW, w.gridH,
      JSON.stringify(w.series), JSON.stringify(w.vizConfig), i,
    ];
    const placeholders = columns.map((col, idx) => {
      params.push(values[idx]);
      return jsonbColumns.has(col) ? `$${paramIdx++}::jsonb` : `$${paramIdx++}`;
    });
    return `(${placeholders.join(',')})`;
  });
  await client.query(`INSERT INTO dashboard_widgets (${columns.join(',')}) VALUES ${valueClauses.join(',')}`, params);
}

/**
 * Full replace — delete-then-reinsert, same convention as Report Builder's
 * saveStructure(): widgets store configuration only (never computed
 * amounts), so recomputing from scratch on every save is cheap and leaves no
 * partial-update drift. `userId = null` targets the company-wide default
 * layout for `tabKey` instead of a personal one — the caller (the API
 * route) is responsible for the role check that gates who may do that.
 * Ensures the parent `dashboard_layouts` row exists first (upsert-for-id,
 * via the tab_key-aware partial unique indexes in schema.sql), then
 * replaces its widgets, all in one transaction.
 */
export async function saveLayout(companyId: string, userId: string | null, tabKey: TabKey, widgets: DashboardWidget[]): Promise<string> {
  return withTransaction((client) => saveLayoutWithClient(client, companyId, userId, tabKey, widgets));
}

/** saveLayout()'s body on a caller-owned transaction — lets creating a custom tab and seeding its starting layout (template / copied tab) commit or roll back together. */
export async function saveLayoutWithClient(
  client: PoolClient, companyId: string, userId: string | null, tabKey: TabKey, widgets: DashboardWidget[],
): Promise<string> {
  let layoutId: string;
  if (userId) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO dashboard_layouts (company_id, user_id, tab_key) VALUES ($1,$2,$3)
       ON CONFLICT (company_id, user_id, tab_key) WHERE user_id IS NOT NULL
       DO UPDATE SET updated_at = NOW() RETURNING id`,
      [companyId, userId, tabKey]
    );
    layoutId = rows[0]!.id;
  } else {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO dashboard_layouts (company_id, user_id, tab_key) VALUES ($1, NULL, $2)
       ON CONFLICT (company_id, tab_key) WHERE user_id IS NULL
       DO UPDATE SET updated_at = NOW() RETURNING id`,
      [companyId, tabKey]
    );
    layoutId = rows[0]!.id;
  }
  await client.query(`DELETE FROM dashboard_widgets WHERE layout_id=$1`, [layoutId]);
  await insertWidgets(client, layoutId, widgets);
  return layoutId;
}

/** What `userId` currently sees on a tab that has a saved layout: their own, else the company default — null when neither exists (the caller decides the fallback, e.g. a fixed tab's starter widgets). */
export async function loadEffectiveLayout(companyId: string, userId: string, tabKey: TabKey): Promise<DashboardWidget[] | null> {
  const personal = await loadPersonalLayout(companyId, userId, tabKey);
  if (personal) return personal.widgets;
  const companyDefault = await loadCompanyDefaultLayout(companyId, tabKey);
  return companyDefault ? companyDefault.widgets : null;
}

/** Reverts the caller to seeing the company/system/fixed default again for this tab (cascades to its widgets via the FK). */
export async function deletePersonalLayout(companyId: string, userId: string, tabKey: TabKey): Promise<void> {
  await query(`DELETE FROM dashboard_layouts WHERE company_id=$1 AND user_id=$2 AND tab_key=$3`, [companyId, userId, tabKey]);
}
