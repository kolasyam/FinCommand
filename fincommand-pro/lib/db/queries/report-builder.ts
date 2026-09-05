import { query, withTransaction } from '@/lib/db/neon';
import type { PoolClient } from 'pg';
import { v4 as uuid } from 'uuid';
import type { ReportLine, ReportTemplate, LineLedgerMap, LineType } from '@/lib/financial/report-builder-engine';

interface TemplateRow {
  id: string; company_id: string; name: string; created_by: string | null;
  cloned_from_template_id: string | null; created_at: string; updated_at: string;
}
const toTemplate = (r: TemplateRow): ReportTemplate => ({
  id: r.id, companyId: r.company_id, name: r.name, createdBy: r.created_by,
  clonedFromTemplateId: r.cloned_from_template_id, createdAt: r.created_at, updatedAt: r.updated_at,
});

interface LineRow {
  id: string; template_id: string; parent_line_id: string | null; label: string;
  sequence: number; line_type: LineType; sign: number; is_percent_base: boolean; resets_after: boolean;
}
const toLine = (r: LineRow): ReportLine => ({
  id: r.id, templateId: r.template_id, parentLineId: r.parent_line_id, label: r.label,
  sequence: r.sequence, lineType: r.line_type, sign: r.sign as 1 | -1,
  isPercentBase: r.is_percent_base, resetsAfter: r.resets_after,
});

export async function loadTemplates(companyId: string): Promise<ReportTemplate[]> {
  const { rows } = await query<TemplateRow>(
    `SELECT * FROM report_templates WHERE company_id=$1 ORDER BY created_at`, [companyId]
  );
  return rows.map(toTemplate);
}

export async function loadTemplate(companyId: string, templateId: string): Promise<ReportTemplate | null> {
  const { rows } = await query<TemplateRow>(
    `SELECT * FROM report_templates WHERE id=$1 AND company_id=$2`, [templateId, companyId]
  );
  return rows[0] ? toTemplate(rows[0]) : null;
}

export async function loadLinesForTemplate(templateId: string): Promise<ReportLine[]> {
  const { rows } = await query<LineRow>(
    `SELECT * FROM report_lines WHERE template_id=$1 ORDER BY sequence`, [templateId]
  );
  return rows.map(toLine);
}

/** All lines for every template belonging to a company, grouped — used by the Templates gallery (line counts + validation summary per card) without one query per template. */
export async function loadAllLines(companyId: string): Promise<Map<string, ReportLine[]>> {
  const { rows } = await query<LineRow & { company_id: string }>(
    `SELECT rl.* FROM report_lines rl
     JOIN report_templates rt ON rt.id = rl.template_id
     WHERE rt.company_id=$1 ORDER BY rl.sequence`, [companyId]
  );
  const map = new Map<string, ReportLine[]>();
  rows.forEach((r) => {
    const line = toLine(r);
    if (!map.has(line.templateId)) map.set(line.templateId, []);
    map.get(line.templateId)!.push(line);
  });
  return map;
}

export async function loadLineLedgerMap(templateId: string): Promise<LineLedgerMap> {
  const { rows } = await query<{ line_id: string; ledger_name: string }>(
    `SELECT rll.line_id, rll.ledger_name FROM report_line_ledgers rll
     JOIN report_lines rl ON rl.id = rll.line_id
     WHERE rl.template_id=$1`, [templateId]
  );
  const map: LineLedgerMap = {};
  rows.forEach((r) => {
    (map[r.line_id] ??= []).push(r.ledger_name);
  });
  return map;
}

/** Same as loadLineLedgerMap but for every template in a company at once — mirrors loadAllLines. */
export async function loadAllLineLedgerMaps(companyId: string): Promise<LineLedgerMap> {
  const { rows } = await query<{ line_id: string; ledger_name: string }>(
    `SELECT rll.line_id, rll.ledger_name FROM report_line_ledgers rll
     JOIN report_lines rl ON rl.id = rll.line_id
     JOIN report_templates rt ON rt.id = rl.template_id
     WHERE rt.company_id=$1`, [companyId]
  );
  const map: LineLedgerMap = {};
  rows.forEach((r) => {
    (map[r.line_id] ??= []).push(r.ledger_name);
  });
  return map;
}

export async function createTemplate(
  companyId: string, userId: string, name: string
): Promise<ReportTemplate> {
  const { rows } = await query<TemplateRow>(
    `INSERT INTO report_templates (company_id, name, created_by) VALUES ($1,$2,$3) RETURNING *`,
    [companyId, name, userId]
  );
  return toTemplate(rows[0]!);
}

/**
 * Builds a parameterized multi-row INSERT — `rows.length` VALUES tuples in
 * one round-trip instead of one query per row. Same batching convention
 * lib/services/zoho.ts already uses for its own bulk ledger/vendor/customer
 * inserts; factored out here since Report Builder's write paths (clone,
 * bulk structure save, bulk ledger mapping) all need the identical shape.
 */
function buildMultiRowInsert(table: string, columns: string[], rows: unknown[][]): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  let paramIdx = 1;
  const valueClauses = rows.map((row) => {
    const placeholders = row.map((v) => { params.push(v); return `$${paramIdx++}`; });
    return `(${placeholders.join(',')})`;
  });
  return {
    sql: `INSERT INTO ${table} (${columns.join(',')}) VALUES ${valueClauses.join(',')}`,
    params,
  };
}

/** Creates a new template and copies another template's lines + ledger mappings into it (fresh ids, same structure) — two multi-row INSERTs total, not one query per line/mapping. */
export async function cloneTemplate(
  companyId: string, userId: string, name: string, sourceTemplateId: string
): Promise<ReportTemplate> {
  return withTransaction(async (client: PoolClient) => {
    const { rows: tplRows } = await client.query<TemplateRow>(
      `INSERT INTO report_templates (company_id, name, created_by, cloned_from_template_id)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [companyId, name, userId, sourceTemplateId]
    );
    const template = toTemplate(tplRows[0]!);

    const { rows: sourceLines } = await client.query<LineRow>(
      `SELECT * FROM report_lines WHERE template_id=$1 ORDER BY sequence`, [sourceTemplateId]
    );
    if (sourceLines.length === 0) return template;

    const idMap = new Map<string, string>();
    sourceLines.forEach((l) => idMap.set(l.id, uuid()));

    const lineRows = sourceLines.map((l) => [
      idMap.get(l.id), template.id, l.parent_line_id ? idMap.get(l.parent_line_id) : null,
      l.label, l.sequence, l.line_type, l.sign, l.is_percent_base, l.resets_after,
    ]);
    const lineInsert = buildMultiRowInsert(
      'report_lines',
      ['id', 'template_id', 'parent_line_id', 'label', 'sequence', 'line_type', 'sign', 'is_percent_base', 'resets_after'],
      lineRows,
    );
    await client.query(lineInsert.sql, lineInsert.params);

    const { rows: sourceMap } = await client.query<{ line_id: string; ledger_name: string }>(
      `SELECT rll.line_id, rll.ledger_name FROM report_line_ledgers rll
       WHERE rll.line_id = ANY($1)`, [sourceLines.map((l) => l.id)]
    );
    if (sourceMap.length > 0) {
      const mapRows = sourceMap
        .map((m) => [idMap.get(m.line_id), m.ledger_name])
        .filter((row): row is [string, string] => Boolean(row[0]));
      if (mapRows.length > 0) {
        const mapInsert = buildMultiRowInsert('report_line_ledgers', ['line_id', 'ledger_name'], mapRows);
        await client.query(mapInsert.sql, mapInsert.params);
      }
    }

    return template;
  });
}

export async function renameTemplate(companyId: string, templateId: string, name: string): Promise<void> {
  await query(
    `UPDATE report_templates SET name=$1, updated_at=NOW() WHERE id=$2 AND company_id=$3`,
    [name, templateId, companyId]
  );
}

export async function deleteTemplate(companyId: string, templateId: string): Promise<void> {
  // report_lines/report_line_ledgers/report_saved_reports all cascade via FK ON DELETE CASCADE.
  await query(`DELETE FROM report_templates WHERE id=$1 AND company_id=$2`, [templateId, companyId]);
}

export interface StructureLineInput {
  id: string; // client-generated UUID — see this module's own note in the API route on why ids are never server-regenerated
  parentLineId: string | null;
  label: string;
  sequence: number;
  lineType: LineType;
  sign: 1 | -1;
  isPercentBase: boolean;
  resetsAfter: boolean;
}

/**
 * Replaces a template's entire line structure in one transaction. Ledger
 * mappings for lines that still exist after the replace are preserved
 * (matched by id); mappings for lines that no longer exist are dropped via
 * cascade. IDs are client-supplied UUIDs, never server-regenerated — the
 * client (StructureEditor) already generates a real UUID the moment a line
 * is added, specifically so this bulk save never needs to remap ids the
 * client-side LedgerMapper/report-run screens might already be holding.
 */
export async function saveStructure(templateId: string, lines: StructureLineInput[]): Promise<void> {
  await withTransaction(async (client: PoolClient) => {
    await client.query(`DELETE FROM report_lines WHERE template_id=$1`, [templateId]);
    if (lines.length === 0) return;
    const insert = buildMultiRowInsert(
      'report_lines',
      ['id', 'template_id', 'parent_line_id', 'label', 'sequence', 'line_type', 'sign', 'is_percent_base', 'resets_after'],
      lines.map((l) => [l.id, templateId, l.parentLineId, l.label, l.sequence, l.lineType, l.sign, l.isPercentBase, l.resetsAfter]),
    );
    await client.query(insert.sql, insert.params);
  });
}

export async function setLineLedgers(lineId: string, ledgerNames: string[]): Promise<void> {
  await withTransaction(async (client: PoolClient) => {
    await client.query(`DELETE FROM report_line_ledgers WHERE line_id=$1`, [lineId]);
    if (ledgerNames.length === 0) return;
    const insert = buildMultiRowInsert('report_line_ledgers', ['line_id', 'ledger_name'], ledgerNames.map((name) => [lineId, name]));
    await client.query(insert.sql, insert.params);
  });
}

/**
 * Sets ledger mappings for MANY lines in one transaction/round-trip —
 * specifically for preset application (app/api/v1/report-builder/templates
 * POST), which previously called setLineLedgers() once per detail line
 * (up to a dozen+ sequential transactions for one "Quick build" click).
 * Not used by the interactive Ledger Mapper screen, where one line at a
 * time really is the right granularity (one user click = one line).
 */
export async function setAllLineLedgers(pairs: { lineId: string; ledgerNames: string[] }[]): Promise<void> {
  const withLedgers = pairs.filter((p) => p.ledgerNames.length > 0);
  if (withLedgers.length === 0) return;
  await withTransaction(async (client: PoolClient) => {
    const rows = withLedgers.flatMap((p) => p.ledgerNames.map((name) => [p.lineId, name]));
    const insert = buildMultiRowInsert('report_line_ledgers', ['line_id', 'ledger_name'], rows);
    await client.query(insert.sql, insert.params);
  });
}

// ── Saved reports ──────────────────────────────────────────────────────

export interface SavedReportRow {
  id: string; company_id: string; template_id: string; financial_year_id: string;
  name: string; month_indices: number[]; show_percent: boolean;
  created_by: string | null; created_at: string; updated_at: string; last_run_at: string | null;
}

export async function loadSavedReports(companyId: string): Promise<SavedReportRow[]> {
  const { rows } = await query<SavedReportRow>(
    `SELECT * FROM report_saved_reports WHERE company_id=$1 ORDER BY updated_at DESC`, [companyId]
  );
  return rows;
}

export async function createSavedReport(input: {
  companyId: string; templateId: string; financialYearId: string; name: string;
  monthIndices: number[]; showPercent: boolean; userId: string;
}): Promise<SavedReportRow> {
  const { rows } = await query<SavedReportRow>(
    `INSERT INTO report_saved_reports
      (company_id, template_id, financial_year_id, name, month_indices, show_percent, created_by, last_run_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,NOW()) RETURNING *`,
    [input.companyId, input.templateId, input.financialYearId, input.name, JSON.stringify(input.monthIndices), input.showPercent, input.userId]
  );
  return rows[0]!;
}

export async function updateSavedReport(
  companyId: string, id: string,
  patch: { name?: string; monthIndices?: number[]; showPercent?: boolean; financialYearId?: string }
): Promise<void> {
  await query(
    `UPDATE report_saved_reports SET
      name=COALESCE($1,name),
      month_indices=COALESCE($2::jsonb,month_indices),
      show_percent=COALESCE($3,show_percent),
      financial_year_id=COALESCE($4,financial_year_id),
      updated_at=NOW(), last_run_at=NOW()
     WHERE id=$5 AND company_id=$6`,
    [patch.name ?? null, patch.monthIndices ? JSON.stringify(patch.monthIndices) : null,
     patch.showPercent ?? null, patch.financialYearId ?? null, id, companyId]
  );
}

export async function touchSavedReportRun(companyId: string, id: string): Promise<void> {
  await query(`UPDATE report_saved_reports SET last_run_at=NOW() WHERE id=$1 AND company_id=$2`, [id, companyId]);
}

export async function deleteSavedReport(companyId: string, id: string): Promise<void> {
  await query(`DELETE FROM report_saved_reports WHERE id=$1 AND company_id=$2`, [id, companyId]);
}
