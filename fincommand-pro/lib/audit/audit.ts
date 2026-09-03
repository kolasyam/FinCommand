import type { NextRequest } from 'next/server';
import { query } from '@/lib/db/neon';
import type { AuthUser } from '@/lib/auth/permissions';

/**
 * Records a row in audit_trail. Non-blocking by design — mirrors the
 * original middleware/audit.js, which fires the insert but never lets a
 * logging failure affect the API response.
 */
export function logAudit(
  req: NextRequest,
  user: AuthUser,
  action: string,
  entityType: string | null = null,
  entityId: string | null = null,
  metadataExtra: Record<string, unknown> = {}
): void {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || null;
  query(
    `INSERT INTO audit_trail
      (company_id, user_id, user_name, user_role, action,
       entity_type, entity_id, metadata, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      user.company_id, user.id, user.name, user.role,
      action, entityType, entityId,
      JSON.stringify({ method: req.method, path: req.nextUrl.pathname, query: Object.fromEntries(req.nextUrl.searchParams), ...metadataExtra }),
      ip, req.headers.get('user-agent') || null,
    ]
  ).catch(() => {}); // non-blocking, matches original behavior
}
