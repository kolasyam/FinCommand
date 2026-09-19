import type { NextRequest } from 'next/server';
import { authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { logAudit } from '@/lib/audit/audit';
import { loadCustomTabs, createCustomTab, countLayoutsForTabs, resolveTabKey } from '@/lib/db/queries/custom-tabs';
import { loadEffectiveLayout } from '@/lib/db/queries/dashboard-builder';
import { loadCustomMetrics } from '@/lib/db/queries/custom-metrics';
import { parseWidgetsInput, isTabKey, type DashboardWidget } from '@/lib/financial/dashboard-builder-engine';
import { parseSharingInput } from '@/lib/dashboard-builder/tab-access';
import { findTemplate } from '@/lib/dashboard-builder/templates';
import { STARTER_WIDGETS_BY_TAB } from '@/lib/dashboard-builder/default-layout';

export const runtime = 'nodejs';

/**
 * GET — the custom tabs the caller may see (sharing enforced server-side —
 * see tab-access.ts), each with `layoutCount` (saved personal +
 * company-default views under its key) so the manage UI can warn before a
 * delete removes teammates' views.
 */
export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  const tabs = await loadCustomTabs(user.company_id, user);
  const counts = await countLayoutsForTabs(user.company_id, tabs.map((t) => t.tabKey));
  return json({ tabs: tabs.map((t) => ({ ...t, layoutCount: counts[t.tabKey] ?? 0 })) });
});

/**
 * POST — creates a new custom dashboard tab. Role-gated to ROLE_SETS.isCFO
 * (admin/cfo). Optional starting content, saved as the tab's company-default
 * layout in the same transaction as the tab:
 *   - `template`: a gallery template key (lib/dashboard-builder/templates.ts),
 *   - `copyFromTabKey`: any tab the caller can see — copies what the caller
 *     currently sees there (their own view, else the company default, else a
 *     fixed tab's starter layout).
 * Nothing is persisted until this call — an abandoned create flow leaves
 * nothing behind.
 */
export const POST = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.isCFO);

  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : null;
  const icon = typeof body.icon === 'string' ? body.icon.trim() : null;

  if (!name) return json({ error: 'name is required' }, { status: 400 });
  if (name.length > 100) return json({ error: 'name must be 100 characters or fewer' }, { status: 400 });
  if (description && description.length > 300) return json({ error: 'description must be 300 characters or fewer' }, { status: 400 });
  if (icon && icon.length > 10) return json({ error: 'icon must be a single emoji' }, { status: 400 });

  const sharing = parseSharingInput(body.visibility ?? 'company', body.sharedRoles ?? []);
  if (!sharing.ok) return json({ error: sharing.error }, { status: 400 });

  const templateKey = typeof body.template === 'string' && body.template ? body.template : null;
  const copyFromParam = typeof body.copyFromTabKey === 'string' && body.copyFromTabKey ? body.copyFromTabKey : null;
  if (templateKey && copyFromParam) return json({ error: 'Choose either a template or a tab to copy, not both' }, { status: 400 });

  let startWidgets: DashboardWidget[] = [];
  let startedFrom: string | null = null;
  if (templateKey) {
    const template = findTemplate(templateKey);
    if (!template) return json({ error: `Unknown template "${templateKey}"` }, { status: 400 });
    startWidgets = template.widgets;
    startedFrom = `template:${template.key}`;
  } else if (copyFromParam) {
    const sourceKey = await resolveTabKey(user.company_id, copyFromParam, user);
    if (!sourceKey) return json({ error: 'The tab to copy was not found' }, { status: 400 });
    const saved = await loadEffectiveLayout(user.company_id, user.id, sourceKey);
    startWidgets = saved ?? (isTabKey(sourceKey) ? STARTER_WIDGETS_BY_TAB[sourceKey] : []);
    startedFrom = `tab:${sourceKey}`;
  }

  // Re-validate the starting widgets exactly like a real Save (a copied tab
  // may bind custom metrics — those must still exist).
  let initialWidgets: DashboardWidget[] = [];
  if (startWidgets.length) {
    const customKeys = new Set((await loadCustomMetrics(user.company_id)).map((m) => m.key));
    const parsed = parseWidgetsInput(startWidgets, 12, customKeys);
    if ('error' in parsed) return json({ error: `Starting layout is invalid: ${parsed.error}` }, { status: 400 });
    initialWidgets = parsed.widgets;
  }

  const tab = await createCustomTab(user.company_id, user.id, {
    name, description, icon,
    visibility: sharing.visibility, sharedRoles: sharing.sharedRoles,
    startedFrom, initialWidgets,
  });
  logAudit(req, user, 'custom_tab.create', 'custom_tab', tab.id, {
    name, tab_key: tab.tabKey, visibility: tab.visibility, shared_roles: tab.sharedRoles,
    started_from: startedFrom, widget_count: initialWidgets.length,
  });
  return json({ tab: { ...tab, layoutCount: initialWidgets.length ? 1 : 0 } }, { status: 201 });
});
