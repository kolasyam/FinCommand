import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { loadLedgers } from '@/lib/db/queries/reports';

export const runtime = 'nodejs';

/**
 * GET: the real, current ledger list for one financial year — name, section
 * and note, deduplicated by name. Feeds the Ledger Mapper's picker and the
 * Structure Editor's live client-side validation (sign-vs-section check),
 * same live-as-you-type responsiveness the reference tool has, without a
 * round-trip per keystroke.
 */
export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  const fyId = req.nextUrl.searchParams.get('fy_id');
  if (!fyId) return json({ error: 'fy_id required' }, { status: 400 });

  const ledgers = await loadLedgers(user.company_id, fyId);
  const byName = new Map<string, { name: string; section: string | null; noteName: string | null }>();
  ledgers.forEach((l) => {
    if (!byName.has(l.ledger_name)) {
      byName.set(l.ledger_name, { name: l.ledger_name, section: l.section ?? null, noteName: l.note_name ?? null });
    }
  });
  const result = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return json({ ledgers: result });
});
