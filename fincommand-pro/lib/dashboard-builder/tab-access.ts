/**
 * Who may see a custom dashboard tab — the ONE rule, pure and DB-free, used
 * by every server route that reads or writes a custom tab or its layouts
 * (lib/db/queries/custom-tabs.ts) and by the client purely for display
 * hints. The server is the enforcement point; the client copy only decides
 * what to render.
 *
 *  - 'company' — everyone in the company (the pre-sharing behavior, and the
 *    default, so every tab created before sharing existed is unchanged).
 *  - 'roles'   — only users whose role is in `sharedRoles`.
 *  - 'private' — only the tab's creator.
 *
 * Always, regardless of visibility: the creator sees their own tab, and an
 * admin sees every tab (someone must be able to find, re-share, or remove a
 * tab whose creator left).
 */

export const TAB_VISIBILITIES = ['company', 'roles', 'private'] as const;
export type TabVisibility = typeof TAB_VISIBILITIES[number];

/** Mirrors lib/auth/permissions.ts's Role union (server-only module — not importable here). */
export const SHAREABLE_ROLES = ['admin', 'cfo', 'ceo', 'auditor', 'manager', 'viewer'] as const;
export type ShareableRole = typeof SHAREABLE_ROLES[number];

export const ROLE_LABELS: Record<ShareableRole, string> = {
  admin: 'Admin', cfo: 'CFO', ceo: 'CEO', auditor: 'Auditor', manager: 'Manager', viewer: 'Viewer',
};

export interface TabAccessFields {
  visibility: TabVisibility;
  sharedRoles: string[];
  createdBy: string | null;
}

export interface TabViewer { id: string; role: string }

export function canViewCustomTab(tab: TabAccessFields, viewer: TabViewer): boolean {
  if (viewer.role === 'admin') return true;
  if (tab.createdBy && tab.createdBy === viewer.id) return true;
  switch (tab.visibility) {
    case 'company': return true;
    case 'roles': return tab.sharedRoles.includes(viewer.role);
    case 'private': return false;
    default: return false;
  }
}

export type ParseSharingResult =
  | { ok: true; visibility: TabVisibility; sharedRoles: ShareableRole[] }
  | { ok: false; error: string };

/** Validates client-supplied sharing settings — unknown visibility/roles rejected, roles de-duplicated and ordered; `sharedRoles` is only meaningful (and required non-empty) for 'roles'. */
export function parseSharingInput(visibilityRaw: unknown, rolesRaw: unknown): ParseSharingResult {
  const visibility = (TAB_VISIBILITIES as readonly string[]).includes(String(visibilityRaw)) ? (visibilityRaw as TabVisibility) : null;
  if (!visibility) return { ok: false, error: `visibility must be one of: ${TAB_VISIBILITIES.join(', ')}` };
  if (visibility !== 'roles') return { ok: true, visibility, sharedRoles: [] };
  if (!Array.isArray(rolesRaw)) return { ok: false, error: 'sharedRoles must be a list of roles' };
  const unknown = rolesRaw.filter((r) => !(SHAREABLE_ROLES as readonly string[]).includes(String(r)));
  if (unknown.length) return { ok: false, error: `Unknown role(s): ${unknown.join(', ')}` };
  const sharedRoles = SHAREABLE_ROLES.filter((r) => rolesRaw.includes(r));
  if (!sharedRoles.length) return { ok: false, error: 'Pick at least one role to share with' };
  return { ok: true, visibility, sharedRoles };
}

export function describeSharing(tab: Pick<TabAccessFields, 'visibility' | 'sharedRoles'>): string {
  if (tab.visibility === 'company') return 'Everyone in the company';
  if (tab.visibility === 'private') return 'Only the creator (and admins)';
  const roles = tab.sharedRoles.map((r) => ROLE_LABELS[r as ShareableRole] ?? r);
  return roles.length ? `${roles.join(', ')} (and admins)` : 'No roles selected';
}
