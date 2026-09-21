import type { NextRequest } from 'next/server';
import { authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { getModule, ZOHO_MODULES, ZOHO_REPORTS, type ModuleDef } from '@/lib/services/zoho/modules';
import { runModuleSlice } from '@/lib/services/zoho/records-sync';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Reads one time-boxed slice of Zoho records into the mirror. Call it again with
 * the returned `runStartedAt` until `done` is true (the Upload tab does this).
 * Body: { mode?: 'incremental' | 'full', modules?: string[], run_started_at?: string, enable_detail?: string[] }
 */
export const POST = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.isCFO);

  const body = await req.json().catch(() => ({})) as {
    mode?: string; modules?: unknown; run_started_at?: unknown; enable_detail?: unknown;
  };
  const mode = body.mode === 'full' ? 'full' : 'incremental';

  let modules: ModuleDef[] = ZOHO_MODULES;
  if (Array.isArray(body.modules) && body.modules.length) {
    const picked = body.modules.map((k) => (typeof k === 'string' ? getModule(k) : undefined));
    if (picked.some((m) => !m)) return json({ error: 'Unknown module in "modules"' }, { status: 400 });
    modules = picked as ModuleDef[];
  }
  const enableDetail = Array.isArray(body.enable_detail) ? body.enable_detail.filter((k): k is string => typeof k === 'string') : undefined;
  const runStartedAt = typeof body.run_started_at === 'string' && !Number.isNaN(Date.parse(body.run_started_at)) ? body.run_started_at : undefined;

  // Zoho's own report totals are read with the records, unless the caller picked specific modules.
  const reports = Array.isArray(body.modules) && body.modules.length ? [] : ZOHO_REPORTS;
  const result = await runModuleSlice(user.company_id, { modules, mode, runStartedAt, enableDetail, reports });
  return json(result);
});
