import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { query } from '@/lib/db/neon';

export const runtime = 'nodejs';

export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  const { rows } = await query(
    `SELECT id, org_id, data_center, sync_frequency, last_synced_at,
            last_sync_status, last_sync_error, synced_ledgers,
            is_active, refresh_token IS NOT NULL AS has_token,
            token_expiry > NOW() AS token_valid
     FROM zoho_config WHERE company_id=$1`,
    [user.company_id]
  );
  if (!rows.length) return json({ connected: false });
  const row = rows[0] as Record<string, unknown>;
  const connected = Boolean(row.is_active && row.has_token);
  return json({ ...row, connected });
});
