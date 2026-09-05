import type { NextRequest } from 'next/server';
import { authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { logAudit } from '@/lib/audit/audit';
import { loadTemplate, saveStructure, loadLineLedgerMap, type StructureLineInput } from '@/lib/db/queries/report-builder';
import { loadLedgers } from '@/lib/db/queries/reports';
import { getFY } from '@/lib/db/queries/reports';
import { validateTemplate, type LineType } from '@/lib/financial/report-builder-engine';
import type { Section } from '@/lib/financial/tb-engine';

export const runtime = 'nodejs';

interface StructureBody {
  lines: {
    id: string; parentLineId: string | null; label: string; sequence: number;
    lineType: LineType; sign: 1 | -1; isPercentBase?: boolean; resetsAfter?: boolean;
  }[];
  /** Optional — only used to resolve real ledger sections for the returned validation result. */
  financialYearId?: string;
}

/**
 * PUT: bulk-replaces this template's entire line structure in one
 * transaction — the Structure Editor collects every edit (add/reorder/
 * indent/rename/sign/type) in local state and calls this once on
 * "Validate & Save", rather than one request per keystroke or drag. Line
 * ids are client-generated UUIDs (never server-regenerated) specifically so
 * ledger mappings already saved against a line survive a structure re-save.
 * Returns the real validation result so the client doesn't need a second
 * round-trip to show it.
 */
export const PUT = withErrorHandling(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.isCFO);
  const { id } = await params;

  const template = await loadTemplate(user.company_id, id);
  if (!template) return json({ error: 'Template not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as StructureBody;
  if (!Array.isArray(body.lines)) return json({ error: 'lines[] is required' }, { status: 400 });

  const lines: StructureLineInput[] = body.lines.map((l) => ({
    id: l.id,
    parentLineId: l.parentLineId ?? null,
    label: l.label,
    sequence: l.sequence,
    lineType: l.lineType,
    sign: l.sign,
    isPercentBase: Boolean(l.isPercentBase),
    resetsAfter: Boolean(l.resetsAfter),
  }));

  await saveStructure(id, lines);
  logAudit(req, user, 'report_builder.template.save_structure', 'report_template', id, { lineCount: lines.length });

  let ledgerSectionByName = new Map<string, Section | null>();
  if (body.financialYearId) {
    const fy = await getFY(user.company_id, body.financialYearId);
    if (fy) {
      const ledgers = await loadLedgers(user.company_id, body.financialYearId);
      ledgerSectionByName = new Map(ledgers.map((l) => [l.ledger_name, (l.section as Section) ?? null]));
    }
  }
  const lineLedgerMap = await loadLineLedgerMap(id);
  const validation = validateTemplate(
    lines.map((l) => ({ ...l, templateId: id })),
    lineLedgerMap,
    ledgerSectionByName,
  );

  return json({ message: 'Structure saved', validation });
});
