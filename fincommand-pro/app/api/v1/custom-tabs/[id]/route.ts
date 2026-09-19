import type { NextRequest } from 'next/server';
import { authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { logAudit } from '@/lib/audit/audit';
import { getCustomTab, updateCustomTab, deleteCustomTab, countLayoutsForTab, type UpdateCustomTabInput } from '@/lib/db/queries/custom-tabs';
import { parseSharingInput } from '@/lib/dashboard-builder/tab-access';

export const runtime = 'nodejs';

/**
 * PUT — renames a custom tab and/or changes who it's shared with. Never
 * accepts tab_key (immutable). Role-gated to ROLE_SETS.isCFO, and the caller
 * must be able to see the tab (a private tab of another CFO is a 404 here,
 * same as it's absent from their list).
 */
export const PUT = withErrorHandling(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.isCFO);
  const { id } = await params;

  const existing = await getCustomTab(user.company_id, id, user);
  if (!existing) return json({ error: 'Custom tab not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const input: UpdateCustomTabInput = {};
  if (typeof body.name === 'string') {
    const name = body.name.trim();
    if (!name) return json({ error: 'name cannot be empty' }, { status: 400 });
    if (name.length > 100) return json({ error: 'name must be 100 characters or fewer' }, { status: 400 });
    input.name = name;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'description')) {
    const description = typeof body.description === 'string' ? body.description.trim() : null;
    if (description && description.length > 300) return json({ error: 'description must be 300 characters or fewer' }, { status: 400 });
    input.description = description || null;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'icon')) {
    const icon = typeof body.icon === 'string' ? body.icon.trim() : null;
    if (icon && icon.length > 10) return json({ error: 'icon must be a single emoji' }, { status: 400 });
    input.icon = icon || null;
  }
  if (typeof body.sortOrder === 'number' && Number.isFinite(body.sortOrder)) input.sortOrder = body.sortOrder;
  if (Object.prototype.hasOwnProperty.call(body, 'visibility')) {
    const sharing = parseSharingInput(body.visibility, body.sharedRoles ?? []);
    if (!sharing.ok) return json({ error: sharing.error }, { status: 400 });
    input.visibility = sharing.visibility;
    input.sharedRoles = sharing.sharedRoles;
  }

  const updated = await updateCustomTab(user.company_id, id, input);
  if (!updated) return json({ error: 'Custom tab not found' }, { status: 404 });

  const sharingChanged = input.visibility !== undefined
    && (input.visibility !== existing.visibility || JSON.stringify(input.sharedRoles) !== JSON.stringify(existing.sharedRoles));
  logAudit(
    req, user, sharingChanged ? 'custom_tab.share' : 'custom_tab.rename', 'custom_tab', id, { name: updated.name },
    { name: existing.name, visibility: existing.visibility, shared_roles: existing.sharedRoles },
    { name: updated.name, visibility: updated.visibility, shared_roles: updated.sharedRoles },
  );
  return json({ tab: updated });
});

/**
 * DELETE — removes a custom tab AND every dashboard_layouts row saved under
 * its tab_key in one transaction (app-code cascade — there's no DB FK).
 * Role-gated to ROLE_SETS.isCFO; the caller must be able to see the tab.
 */
export const DELETE = withErrorHandling(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.isCFO);
  const { id } = await params;

  const tab = await getCustomTab(user.company_id, id, user);
  if (!tab) return json({ error: 'Custom tab not found' }, { status: 404 });

  const layoutCount = await countLayoutsForTab(user.company_id, tab.tabKey);
  const deleted = await deleteCustomTab(user.company_id, id);
  if (!deleted) return json({ error: 'Custom tab not found' }, { status: 404 });

  logAudit(req, user, 'custom_tab.delete', 'custom_tab', id, { name: tab.name, tab_key: tab.tabKey, layouts_removed: layoutCount });
  return json({ message: 'Custom tab deleted.', layouts_removed: layoutCount });
});
