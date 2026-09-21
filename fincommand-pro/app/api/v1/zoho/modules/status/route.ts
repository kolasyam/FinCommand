import type { NextRequest } from 'next/server';
import { authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { query } from '@/lib/db/neon';
import { moduleCounts, loadStates, snapshotSummaries } from '@/lib/db/queries/zoho-records';
import { ZOHO_MODULES, ZOHO_REPORTS, detailDefault } from '@/lib/services/zoho/modules';
import { getZohoUsage } from '@/lib/services/zoho/usage';
import { NEEDS_ATTENTION_AFTER, projectedDailyCalls } from '@/lib/services/zoho/budget';

export const runtime = 'nodejs';

/** What has been read from Zoho, per module, and how much of today's API allowance is used. */
export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.zohoRecords);

  const companyId = user.company_id;
  const keys = [...ZOHO_MODULES.map((m) => m.key), ...ZOHO_REPORTS.map((r) => `report:${r.key}`)];
  const [counts, states, snapshots, usage, cfg] = await Promise.all([
    moduleCounts(companyId),
    loadStates(companyId, keys),
    snapshotSummaries(companyId),
    getZohoUsage(companyId),
    query<{ is_active: boolean; sync_frequency: string; consecutive_failures: number; next_attempt_at: string | null; refresh_token: string | null }>(
      `SELECT is_active, sync_frequency, consecutive_failures, next_attempt_at, refresh_token FROM zoho_config WHERE company_id=$1`, [companyId]),
  ]);
  const c = cfg.rows[0];

  return json({
    connected: Boolean(c?.is_active && c.refresh_token),
    modules: ZOHO_MODULES.map((m) => {
      const n = counts.get(m.key);
      const s = states.get(m.key);
      return {
        key: m.key, label: m.label, phase: m.phase, detail_mode: m.detail,
        detail_enabled: s?.detail_enabled ?? detailDefault(m),
        records: n?.records ?? 0, removed: n?.removed ?? 0,
        with_detail: n?.with_detail ?? 0, detail_pending: n?.detail_pending ?? 0, detail_failed: n?.detail_failed ?? 0,
        last_full_at: s?.last_full_at ?? null, last_incremental_at: s?.last_incremental_at ?? null,
        reading: Boolean(s?.pass_kind), last_error: s?.last_error ?? null,
      };
    }),
    reports: ZOHO_REPORTS.map((r) => {
      const s = snapshots.get(r.key);
      const state = states.get(`report:${r.key}`);
      return { key: r.key, label: r.label, snapshots: s?.snapshots ?? 0, last_read_at: s?.last_seen_at ?? null, last_error: state?.last_error ?? null };
    }),
    usage,
    statement_sync: {
      frequency: c?.sync_frequency ?? null,
      projected_daily_calls: c ? projectedDailyCalls(c.sync_frequency) : 0,
      consecutive_failures: c?.consecutive_failures ?? 0,
      next_attempt_at: c?.next_attempt_at ?? null,
      needs_attention: (c?.consecutive_failures ?? 0) >= NEEDS_ATTENTION_AFTER,
    },
  });
});
