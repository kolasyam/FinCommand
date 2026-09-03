import type { NextRequest } from 'next/server';
import { authenticate, requireRole, ROLE_SETS, type Role } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { query } from '@/lib/db/neon';
import { isIn, ValidationCollector } from '@/lib/validations/common';

export const runtime = 'nodejs';

const EDITABLE_ROLES = ['admin', 'cfo', 'ceo', 'auditor', 'manager', 'viewer'] as const;
// The only fields this panel is authorized to touch — email and password are
// intentionally absent so a company admin can never view or rotate a
// teammate's login credentials from here, only their access metadata.
const ALLOWED_FIELDS = new Set(['name', 'role', 'is_active']);

interface TargetUserRow { id: string; company_id: string; name: string; role: string; is_active: boolean }

export const PATCH = withErrorHandling(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.isAdmin);
  const { id } = await params;

  const body = await req.json().catch(() => ({}));
  if (typeof body !== 'object' || body === null) return json({ error: 'Invalid request body' }, { status: 400 });

  const disallowedKeys = Object.keys(body).filter(k => !ALLOWED_FIELDS.has(k));
  if (disallowedKeys.some(k => k === 'email' || k === 'password' || k === 'password_hash')) {
    return json(
      { error: 'Editing a user\'s email or password is not permitted from Access Management. The member must change their own password after signing in.' },
      { status: 403 }
    );
  }
  if (disallowedKeys.length) {
    return json({ error: `Unsupported field(s): ${disallowedKeys.join(', ')}. Only name, role, and is_active may be edited here.` }, { status: 400 });
  }

  const hasName = 'name' in body;
  const hasRole = 'role' in body;
  const hasActive = 'is_active' in body;
  if (!hasName && !hasRole && !hasActive) {
    return json({ error: 'Provide at least one of: name, role, is_active' }, { status: 400 });
  }

  const name = hasName ? String(body.name ?? '').trim() : undefined;
  const role = hasRole ? String(body.role ?? '') : undefined;
  const isActive = hasActive ? Boolean(body.is_active) : undefined;

  const v = new ValidationCollector()
    .check(!hasName || name!.length > 0, 'name', 'Name cannot be empty')
    .check(!hasRole || isIn(role, EDITABLE_ROLES), 'role', `Role must be one of: ${EDITABLE_ROLES.join(', ')}`);
  if (!v.isEmpty()) return json({ errors: v.errors() }, { status: 422 });

  const { rows: targetRows } = await query<TargetUserRow>(
    `SELECT id, company_id, name, role, is_active FROM users WHERE id=$1 AND company_id=$2`,
    [id, user.company_id]
  );
  const target = targetRows[0];
  if (!target) return json({ error: 'User not found' }, { status: 404 });

  // Guard rails against an unmanaged company: never let this endpoint strip
  // admin access from your own account, and never let it remove the last
  // active admin — either would orphan the company with nobody able to
  // manage users, upload TBs on their behalf, or lock a financial year.
  const isSelf = target.id === user.id;
  if (isSelf && hasRole && role !== 'admin') {
    return json({ error: 'You cannot change your own role away from admin.' }, { status: 400 });
  }
  if (isSelf && hasActive && isActive === false) {
    return json({ error: 'You cannot deactivate your own account.' }, { status: 400 });
  }

  const willLoseAdmin =
    target.role === 'admin' && target.is_active &&
    ((hasRole && role !== 'admin') || (hasActive && isActive === false));
  if (willLoseAdmin) {
    const { rows: adminCount } = await query<{ count: string }>(
      `SELECT COUNT(*) FROM users WHERE company_id=$1 AND role='admin' AND is_active=TRUE AND id<>$2`,
      [user.company_id, target.id]
    );
    if (parseInt(adminCount[0].count) === 0) {
      return json({ error: 'Cannot remove the last active admin for this company.' }, { status: 409 });
    }
  }

  const { rows: updatedRows } = await query(
    `UPDATE users SET
       name = COALESCE($1, name),
       role = COALESCE($2, role),
       is_active = COALESCE($3, is_active),
       updated_at = NOW()
     WHERE id=$4 AND company_id=$5
     RETURNING id, name, email, role, is_active, last_login, created_at`,
    [name ?? null, (role as Role) ?? null, hasActive ? isActive : null, id, user.company_id]
  );

  const oldValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  if (hasName) { oldValues.name = target.name; newValues.name = name; }
  if (hasRole) { oldValues.role = target.role; newValues.role = role; }
  if (hasActive) { oldValues.is_active = target.is_active; newValues.is_active = isActive; }

  query(
    `INSERT INTO audit_trail (company_id, user_id, user_name, user_role, action, entity_type, entity_id, old_values, new_values)
     VALUES ($1,$2,$3,$4,'USER_UPDATE','user',$5,$6,$7)`,
    [user.company_id, user.id, user.name, user.role, id, JSON.stringify(oldValues), JSON.stringify(newValues)]
  ).catch(() => {});

  return json(updatedRows[0]);
});
