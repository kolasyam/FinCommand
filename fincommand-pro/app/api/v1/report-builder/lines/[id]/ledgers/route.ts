import type { NextRequest } from 'next/server';
import { authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { logAudit } from '@/lib/audit/audit';
import { query } from '@/lib/db/neon';
import { setLineLedgers } from '@/lib/db/queries/report-builder';

export const runtime = 'nodejs';

/** PUT: replaces the set of real ledger names mapped to one detail line — the Ledger Mapper screen's checkbox toggles call this per line, applied immediately (no separate "save" step, matching the reference tool's feel). */
export const PUT = withErrorHandling(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.isCFO);
  const { id: lineId } = await params;

  const { rows } = await query<{ company_id: string }>(
    `SELECT rt.company_id FROM report_lines rl
     JOIN report_templates rt ON rt.id = rl.template_id
     WHERE rl.id=$1`, [lineId]
  );
  if (!rows.length || rows[0]!.company_id !== user.company_id) {
    return json({ error: 'Line not found' }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const ledgerNames: string[] = Array.isArray(body.ledgerNames) ? body.ledgerNames.map(String) : [];

  await setLineLedgers(lineId, ledgerNames);
  logAudit(req, user, 'report_builder.line.set_ledgers', 'report_line', lineId, { count: ledgerNames.length });
  return json({ message: 'Mapping saved', ledgerNames });
});
