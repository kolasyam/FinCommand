import type { NextRequest } from 'next/server';
import { authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { getRecord, listRecords } from '@/lib/db/queries/zoho-records';
import { getModule } from '@/lib/services/zoho/modules';

export const runtime = 'nodejs';

const isoDate = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
const intOr = (v: string | null, d: number) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : d; };

/**
 * Reads mirrored Zoho records, always for the caller's own company.
 *   ?module=bills&q=&contact_id=&status=&from=&to=&page=&per_page=   a page of records (no raw JSON)
 *   ?module=bills&id=<zoho id>                                        one record with its lines, list row and detail
 */
export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.zohoRecords);

  const sp = req.nextUrl.searchParams;
  const module = sp.get('module') ?? '';
  if (!getModule(module)) return json({ error: 'module is required and must be a known Zoho module' }, { status: 400 });

  const id = sp.get('id');
  if (id) {
    const record = await getRecord(user.company_id, module, id);
    if (!record) return json({ error: 'Record not found' }, { status: 404 });
    return json(record);
  }

  return json(await listRecords(user.company_id, {
    module,
    q: sp.get('q')?.trim() || undefined,
    contactId: sp.get('contact_id') || undefined,
    parentId: sp.get('parent_id') || undefined,
    status: sp.get('status') || undefined,
    from: isoDate(sp.get('from')),
    to: isoDate(sp.get('to')),
    includeRemoved: sp.get('include_removed') === 'true',
    page: intOr(sp.get('page'), 1),
    perPage: intOr(sp.get('per_page'), 50),
  }));
});
