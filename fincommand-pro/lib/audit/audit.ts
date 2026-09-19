import type { NextRequest } from 'next/server';
import { query } from '@/lib/db/neon';
import type { AuthUser } from '@/lib/auth/permissions';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Loose shape check only — enough to keep an obviously-invalid forwarded
// header value from failing the INET cast (and with it, the whole insert).
const IP_RE = /^[0-9a-f.:]{2,45}$/i;

/**
 * Records a row in audit_trail. Non-blocking by design — a logging failure
 * never affects the API response — but never SILENT: a failed insert is
 * reported via console.error (CONSTRAINTS.md: never swallow DB exceptions).
 *
 * `entity_id` and `ip_address` are typed columns (UUID / INET). A caller
 * passing a natural key (e.g. a custom metric's `metric_key`) as entityId
 * previously made every such insert fail — and the old `.catch(() => {})`
 * hid it, so custom-metric audit rows were never written at all. A non-UUID
 * entityId is now stored as `metadata.entity_ref` with entity_id NULL, and an
 * unparseable IP as `metadata.ip_raw`, so the row is always written.
 *
 * `oldValues`/`newValues` back the table's `old_values`/`new_values` JSONB
 * columns (a real before/after for edits).
 */
export function logAudit(
  req: NextRequest,
  user: AuthUser,
  action: string,
  entityType: string | null = null,
  entityId: string | null = null,
  metadataExtra: Record<string, unknown> = {},
  oldValues: Record<string, unknown> | null = null,
  newValues: Record<string, unknown> | null = null
): void {
  const rawIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || null;
  const ip = rawIp && IP_RE.test(rawIp) ? rawIp : null;
  const entityUuid = entityId && UUID_RE.test(entityId) ? entityId : null;

  const metadata: Record<string, unknown> = {
    method: req.method,
    path: req.nextUrl.pathname,
    query: Object.fromEntries(req.nextUrl.searchParams),
    ...metadataExtra,
  };
  if (entityId && !entityUuid) metadata.entity_ref = entityId;
  if (rawIp && !ip) metadata.ip_raw = rawIp.slice(0, 100);

  query(
    `INSERT INTO audit_trail
      (company_id, user_id, user_name, user_role, action,
       entity_type, entity_id, old_values, new_values, metadata, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      user.company_id, user.id, user.name, user.role,
      action, entityType, entityUuid,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
      JSON.stringify(metadata),
      ip, req.headers.get('user-agent') || null,
    ]
  ).catch((err: Error) => {
    console.error(`[audit] failed to record "${action}" for company ${user.company_id}:`, err.message);
  });
}
