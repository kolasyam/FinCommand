import type { NextRequest } from 'next/server';
import { authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { logAudit } from '@/lib/audit/audit';
import { query } from '@/lib/db/neon';
import { loadLedgers } from '@/lib/db/queries/reports';
import {
  loadTemplates, loadAllLines, loadAllLineLedgerMaps,
  createTemplate, cloneTemplate, saveStructure, setAllLineLedgers,
} from '@/lib/db/queries/report-builder';
import {
  validateTemplate, FORMAT_PRESETS, resolvePresetLedgers, type ReportTemplate,
} from '@/lib/financial/report-builder-engine';
import type { Section } from '@/lib/financial/tb-engine';
import { v4 as uuid } from 'uuid';

export const runtime = 'nodejs';

/** GET: the format gallery — every template for this company, with a real validation summary per card (unmapped lines, sign mismatches, etc. — see report-builder-engine.ts::validateTemplate), plus the static preset catalogue for "Quick build". */
export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  const [templates, allLines, allMaps] = await Promise.all([
    loadTemplates(user.company_id),
    loadAllLines(user.company_id),
    loadAllLineLedgerMaps(user.company_id),
  ]);

  // Real ledger sections (for the sign-mismatch check) from the most
  // recently created financial year that actually has synced ledgers —
  // non-fatal if none exists yet (a brand-new company with no TB uploaded
  // still gets a real gallery, just without that one specific check).
  const { rows: fyRows } = await query<{ id: string }>(
    `SELECT id FROM financial_years WHERE company_id=$1 ORDER BY start_date DESC`, [user.company_id]
  );
  let ledgerSectionByName = new Map<string, Section | null>();
  for (const fy of fyRows) {
    const ledgers = await loadLedgers(user.company_id, fy.id);
    if (ledgers.length) {
      ledgerSectionByName = new Map(ledgers.map((l) => [l.ledger_name, (l.section as Section) ?? null]));
      break;
    }
  }

  const result = templates.map((t) => {
    const lines = allLines.get(t.id) ?? [];
    const validation = validateTemplate(lines, allMaps, ledgerSectionByName);
    return {
      ...t,
      lineCount: lines.length,
      detailCount: lines.filter((l) => l.lineType === 'detail').length,
      errorCount: validation.errors.length,
      warningCount: validation.warnings.length,
    };
  });
  return json({ templates: result, presets: FORMAT_PRESETS });
});

/**
 * POST: create a format. Three modes, all producing a normal editable
 * template (never read-only — Report Builder has no built-in locked
 * template in this version; see this feature's rollout notes for why the
 * "Statutory Notes as a starting point" idea was deferred):
 *  - { name } — blank canvas
 *  - { name, cloneFromTemplateId } — copy another template's structure + mappings
 *  - { name, presetId, financialYearId } — one of FORMAT_PRESETS, auto-mapped
 *    against this company's REAL ledgers for that financial year (server-side,
 *    since preset resolution needs real data the client never holds)
 */
export const POST = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.isCFO);

  const body = await req.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  if (!name) return json({ error: 'name is required' }, { status: 400 });

  let template: ReportTemplate;
  let mode = 'blank';

  if (body.cloneFromTemplateId) {
    mode = 'clone';
    template = await cloneTemplate(user.company_id, user.id, name, String(body.cloneFromTemplateId));
  } else if (body.presetId) {
    mode = 'preset';
    const preset = FORMAT_PRESETS.find((p) => p.id === body.presetId);
    if (!preset) return json({ error: 'Unknown preset' }, { status: 400 });
    if (!body.financialYearId) {
      return json({ error: 'financialYearId is required to auto-map a preset against real ledgers' }, { status: 400 });
    }
    const ledgers = await loadLedgers(user.company_id, String(body.financialYearId));
    template = await createTemplate(user.company_id, user.id, name);

    const lines = preset.lines.map((def, i) => ({
      id: uuid(),
      parentLineId: null,
      label: def.label,
      sequence: (i + 1) * 10,
      lineType: def.type,
      sign: def.sign ?? (1 as const),
      isPercentBase: Boolean(def.base),
      resetsAfter: Boolean(def.resetsAfter),
    }));
    await saveStructure(template.id, lines);
    // One batched transaction for every line's mapping, not one per line —
    // see setAllLineLedgers()'s own doc comment.
    await setAllLineLedgers(
      preset.lines.map((def, i) => ({ lineId: lines[i]!.id, ledgerNames: resolvePresetLedgers(def, ledgers) })),
    );
  } else {
    template = await createTemplate(user.company_id, user.id, name);
  }

  logAudit(req, user, 'report_builder.template.create', 'report_template', template.id, { name, mode });
  return json({ template }, { status: 201 });
});
