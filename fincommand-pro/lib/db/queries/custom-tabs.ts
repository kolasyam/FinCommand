import { query, withTransaction } from '@/lib/db/neon';
import { isTabKey, type DashboardWidget } from '@/lib/financial/dashboard-builder-engine';
import { canViewCustomTab, type TabViewer, type TabVisibility } from '@/lib/dashboard-builder/tab-access';
import { saveLayoutWithClient } from './dashboard-builder';

export interface CustomTab {
  id: string;
  companyId: string;
  tabKey: string;
  name: string;
  description: string | null;
  icon: string | null;
  sortOrder: number;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  visibility: TabVisibility;
  sharedRoles: string[];
  startedFrom: string | null;
}

interface CustomTabRow {
  id: string; company_id: string; tab_key: string; name: string;
  description: string | null; icon: string | null; sort_order: number;
  created_by: string | null; created_by_name: string | null; created_at: string;
  visibility: TabVisibility; shared_roles: string[] | null; started_from: string | null;
}

const SELECT_TAB = `SELECT t.id, t.company_id, t.tab_key, t.name, t.description, t.icon, t.sort_order,
  t.created_by, u.name AS created_by_name, t.created_at, t.visibility, t.shared_roles, t.started_from
  FROM custom_tabs t LEFT JOIN users u ON u.id = t.created_by`;

function toCustomTab(r: CustomTabRow): CustomTab {
  return {
    id: r.id, companyId: r.company_id, tabKey: r.tab_key, name: r.name,
    description: r.description, icon: r.icon, sortOrder: r.sort_order,
    createdBy: r.created_by, createdByName: r.created_by_name, createdAt: r.created_at,
    visibility: r.visibility ?? 'company', sharedRoles: r.shared_roles ?? [], startedFrom: r.started_from,
  };
}

/**
 * This company's custom tabs that `viewer` may see (tab-access.ts::
 * canViewCustomTab — company-wide, shared with the viewer's role, or their
 * own; admins see all). Every route that lists tabs passes the viewer, so a
 * tab shared with other roles is never even listed for someone outside them.
 */
export async function loadCustomTabs(companyId: string, viewer: TabViewer): Promise<CustomTab[]> {
  const { rows } = await query<CustomTabRow>(
    `${SELECT_TAB} WHERE t.company_id=$1 ORDER BY t.sort_order, t.created_at`,
    [companyId]
  );
  return rows.map(toCustomTab).filter((t) => canViewCustomTab(t, viewer));
}

/** One tab by id, only if `viewer` may see it — null otherwise (callers answer 404 either way, never revealing that an unshared tab exists). */
export async function getCustomTab(companyId: string, id: string, viewer: TabViewer): Promise<CustomTab | null> {
  const { rows } = await query<CustomTabRow>(`${SELECT_TAB} WHERE t.company_id=$1 AND t.id=$2`, [companyId, id]);
  const tab = rows[0] ? toCustomTab(rows[0]) : null;
  return tab && canViewCustomTab(tab, viewer) ? tab : null;
}

/**
 * Resolves a client-sent `tab_key` into a real, storable tab_key for this
 * company AND this viewer — `null` if it's neither a fixed tab nor a custom
 * tab the viewer may see. Fixed tabs never touch the DB. A `custom-` key that
 * doesn't exist, or isn't shared with the viewer, is rejected exactly the
 * same way — so every layout route (read, save, reset, company default)
 * enforces sharing by construction, and can't be used to probe for tabs.
 */
export async function resolveTabKey(companyId: string, tabKeyParam: string | null, viewer: TabViewer): Promise<string | null> {
  if (!tabKeyParam) return null;
  if (isTabKey(tabKeyParam)) return tabKeyParam;
  if (!tabKeyParam.startsWith('custom-')) return null;
  const { rows } = await query<CustomTabRow>(`${SELECT_TAB} WHERE t.company_id=$1 AND t.tab_key=$2`, [companyId, tabKeyParam]);
  const tab = rows[0] ? toCustomTab(rows[0]) : null;
  return tab && canViewCustomTab(tab, viewer) ? tab.tabKey : null;
}

function slugifyTabName(name: string): string {
  const s = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'tab';
}

export interface CreateCustomTabInput {
  name: string;
  description?: string | null;
  icon?: string | null;
  visibility: TabVisibility;
  sharedRoles: string[];
  /** Template key or `tab:<tabKey>` the layout was copied from — provenance only. */
  startedFrom?: string | null;
  /** Starting widgets (already validated by parseWidgetsInput) saved as the new tab's company-default layout, in the same transaction as the tab itself. Empty = blank tab. */
  initialWidgets?: DashboardWidget[];
}

const MAX_KEY_ATTEMPTS = 30;

/**
 * Creates a custom tab (and, when given, its starting company-default
 * layout) in ONE transaction — either both exist afterward or neither does.
 * tab_key is server-generated — 'custom-' + slugify(name), truncated to
 * VARCHAR(50), with -2, -3, ... appended on a collision (chosen up front
 * from the company's existing keys, since a failed INSERT would abort the
 * transaction) — and immutable afterward.
 */
export async function createCustomTab(companyId: string, userId: string, input: CreateCustomTabInput): Promise<CustomTab> {
  const base = `custom-${slugifyTabName(input.name)}`.slice(0, 50);
  return withTransaction(async (client) => {
    // Serialize concurrent creates for the same company so two requests
    // can't both pick the same free key (released at COMMIT/ROLLBACK).
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`custom_tabs:${companyId}`]);
    const { rows: existing } = await client.query<{ tab_key: string; sort_order: number }>(
      `SELECT tab_key, sort_order FROM custom_tabs WHERE company_id=$1`,
      [companyId]
    );
    const taken = new Set(existing.map((r) => r.tab_key));
    let tabKey: string | null = null;
    for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS && !tabKey; attempt++) {
      const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
      const candidate = attempt === 0 ? base : `${base.slice(0, 50 - suffix.length)}${suffix}`;
      if (!taken.has(candidate)) tabKey = candidate;
    }
    if (!tabKey) throw Object.assign(new Error('Too many tabs share this name — choose a more distinctive name.'), { status: 409 });
    const sortOrder = existing.reduce((m, r) => Math.max(m, r.sort_order), -1) + 1;

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO custom_tabs (company_id, tab_key, name, description, icon, sort_order, created_by, visibility, shared_roles, started_from)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10)
       RETURNING id`,
      [
        companyId, tabKey, input.name.trim(), input.description?.trim() || null, input.icon || null, sortOrder, userId,
        input.visibility, input.sharedRoles, input.startedFrom ?? null,
      ]
    );
    if (input.initialWidgets && input.initialWidgets.length) {
      await saveLayoutWithClient(client, companyId, null, tabKey, input.initialWidgets);
    }
    const { rows: created } = await client.query<CustomTabRow>(`${SELECT_TAB} WHERE t.id=$1`, [rows[0]!.id]);
    return toCustomTab(created[0]!);
  });
}

export interface UpdateCustomTabInput {
  name?: string;
  description?: string | null;
  icon?: string | null;
  sortOrder?: number;
  visibility?: TabVisibility;
  sharedRoles?: string[];
}

/** Updates identity and sharing fields — tab_key is intentionally not accepted (immutable once created). */
export async function updateCustomTab(companyId: string, id: string, input: UpdateCustomTabInput): Promise<CustomTab | null> {
  const has = (k: keyof UpdateCustomTabInput) => Object.prototype.hasOwnProperty.call(input, k);
  const { rows } = await query<{ id: string }>(
    `UPDATE custom_tabs SET
       name = COALESCE($3, name),
       description = CASE WHEN $4::boolean THEN $5 ELSE description END,
       icon = CASE WHEN $6::boolean THEN $7 ELSE icon END,
       sort_order = COALESCE($8, sort_order),
       visibility = COALESCE($9, visibility),
       shared_roles = CASE WHEN $10::boolean THEN $11::text[] ELSE shared_roles END,
       updated_at = NOW()
     WHERE company_id=$1 AND id=$2
     RETURNING id`,
    [
      companyId, id,
      input.name?.trim() || null,
      has('description'), input.description?.trim() || null,
      has('icon'), input.icon || null,
      input.sortOrder ?? null,
      input.visibility ?? null,
      has('sharedRoles'), input.sharedRoles ?? [],
    ]
  );
  if (!rows[0]) return null;
  const { rows: updated } = await query<CustomTabRow>(`${SELECT_TAB} WHERE t.id=$1`, [id]);
  return updated[0] ? toCustomTab(updated[0]) : null;
}

/** How many saved dashboard_layouts rows (personal + company-default) exist for a tab — shown before delete. */
export async function countLayoutsForTab(companyId: string, tabKey: string): Promise<number> {
  const { rows } = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM dashboard_layouts WHERE company_id=$1 AND tab_key=$2`,
    [companyId, tabKey]
  );
  return parseInt(rows[0]?.count ?? '0', 10);
}

/** Layout counts for many tabs in one query (the list route previously ran one COUNT per tab). */
export async function countLayoutsForTabs(companyId: string, tabKeys: string[]): Promise<Record<string, number>> {
  if (!tabKeys.length) return {};
  const { rows } = await query<{ tab_key: string; count: string }>(
    `SELECT tab_key, COUNT(*)::text AS count FROM dashboard_layouts
     WHERE company_id=$1 AND tab_key = ANY($2::text[]) GROUP BY tab_key`,
    [companyId, tabKeys]
  );
  const out: Record<string, number> = {};
  rows.forEach((r) => { out[r.tab_key] = parseInt(r.count, 10); });
  return out;
}

/**
 * Deletes a custom tab and every dashboard_layouts row saved under its
 * tab_key (cascading to dashboard_widgets via that table's FK) in one
 * transaction. There's deliberately no FK from dashboard_layouts to
 * custom_tabs, so this two-step delete is what keeps them consistent.
 */
export async function deleteCustomTab(companyId: string, id: string): Promise<boolean> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ tab_key: string }>(
      `SELECT tab_key FROM custom_tabs WHERE company_id=$1 AND id=$2`,
      [companyId, id]
    );
    if (!rows.length) return false;
    const { tab_key } = rows[0];
    await client.query(`DELETE FROM dashboard_layouts WHERE company_id=$1 AND tab_key=$2`, [companyId, tab_key]);
    await client.query(`DELETE FROM custom_tabs WHERE company_id=$1 AND id=$2`, [companyId, id]);
    return true;
  });
}
