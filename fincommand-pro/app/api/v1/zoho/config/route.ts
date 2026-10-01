import type { NextRequest } from 'next/server';
import { authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { query } from '@/lib/db/neon';
import axios from 'axios';
import { fetchAndStoreZohoOrgCurrency, ZOHO_ACCOUNTS } from '@/lib/services/zoho';
import { decryptZohoConfig } from '@/lib/services/zoho/client';
import { isValidDailyLimit, ZOHO_PLAN_LIMITS } from '@/lib/services/zoho/budget';

export const runtime = 'nodejs';

export const PUT = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.isCFO);

  const body = await req.json().catch(() => ({}));
  const { org_id, sync_frequency } = body;

  // The Zoho plan's daily API allowance (Free 1,000 · Standard 2,000 · Professional 5,000 · Premium+ 10,000).
  // It caps how much the record reads may use; it must be one of the plan values, not a free number.
  if (body.api_daily_limit !== undefined && !isValidDailyLimit(body.api_daily_limit)) {
    return json({ error: `api_daily_limit must be one of ${Object.values(ZOHO_PLAN_LIMITS).join(', ')}` }, { status: 400 });
  }

  // One Zoho organisation can feed only one company: two companies sharing it would mix their books.
  // Only a LIVE connection counts (active, holding a token): a leftover or disconnected entry that merely
  // remembers the id - a test company, an abandoned attempt - must not block the real owner from connecting.
  if (typeof org_id === 'string' && org_id.trim()) {
    const { rows: taken } = await query(
      `SELECT 1 FROM zoho_config WHERE org_id=$1 AND company_id<>$2 AND is_active=TRUE AND refresh_token IS NOT NULL LIMIT 1`,
      [org_id.trim(), user.company_id]);
    if (taken.length) return json({ error: 'This Zoho organisation is already connected to another company.' }, { status: 409 });
  }

  // Explicit columns, never RETURNING * — that sent the Zoho access and
  // refresh tokens back to the browser on every save.
  const { rows } = await query(
    `INSERT INTO zoho_config (company_id, org_id, sync_frequency, is_active)
     VALUES ($1, $2, COALESCE($3, 'daily'), TRUE)
     ON CONFLICT (company_id) DO UPDATE SET
       org_id = COALESCE(EXCLUDED.org_id, zoho_config.org_id),
       sync_frequency = COALESCE(EXCLUDED.sync_frequency, zoho_config.sync_frequency),
       is_active = TRUE,
       updated_at = NOW()
     RETURNING company_id, org_id, data_center, sync_frequency, is_active,
               last_synced_at, last_sync_status, last_sync_error, synced_ledgers, updated_at`,
    [user.company_id, org_id ?? null, sync_frequency ?? null]
  );
  if (body.api_daily_limit !== undefined) {
    await query(`UPDATE zoho_config SET api_daily_limit=$1 WHERE company_id=$2`, [body.api_daily_limit, user.company_id]);
  }

  // Auto-detect the org's real Source Currency now that we know its org_id
  // (see Module B — Zoho's own /organizations endpoint, not a guess or a
  // static 'INR' default). Non-fatal: saving the org_id must still succeed
  // even if this lookup fails (network hiccup, token not yet valid, etc.) —
  // the company's `currency` column simply stays whatever it already was.
  let detected_currency: string | null = null;
  // Only when an Organisation ID was actually sent: changing just the plan limit must not call Zoho.
  if (org_id && rows[0]?.org_id) {
    detected_currency = await fetchAndStoreZohoOrgCurrency(user.company_id, rows[0].org_id);
  }

  return json({ ...rows[0], detected_currency });
});

export const DELETE = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.isCFO);

  const { rows: [cfg] } = await query<{ access_token: string | null; refresh_token: string | null; data_center: string | null }>(
    `SELECT access_token, refresh_token, data_center FROM zoho_config WHERE company_id=$1`, [user.company_id]
  );

  await query(
    `UPDATE zoho_config SET
       is_active=FALSE,
       access_token=NULL,
       refresh_token=NULL,
       token_expiry=NULL,
       last_sync_status='never',
       last_sync_error=NULL,
       updated_at=NOW()
     WHERE company_id=$1`,
    [user.company_id]
  );

  // Also tell Zoho, so the grant stops working there too. Best effort: our copy is already gone either way.
  const refreshToken = cfg?.refresh_token ? decryptZohoConfig(cfg).refresh_token : null;
  if (refreshToken) {
    const base = ZOHO_ACCOUNTS[cfg!.data_center || 'IN'] || ZOHO_ACCOUNTS.IN;
    await axios.post(`${base}/oauth/v2/token/revoke`, null, { params: { token: refreshToken }, timeout: 10000 })
      .catch((err: Error) => console.warn('[zoho/config] token revoke at Zoho failed:', err.message));
  }
  return json({ message: 'Zoho Books disconnected successfully' });
});
