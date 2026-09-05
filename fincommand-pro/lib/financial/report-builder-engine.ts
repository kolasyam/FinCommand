/**
 * FinCommand Pro — Report Builder engine
 *
 * Ported and corrected from a Lovable-built UX prototype ("Report Architect
 * Pro") a manager sent as a reference for this exact module. That prototype
 * was 100% client-side against a pseudo-random mock ledger generator — no
 * real data, no backend. Three things were deliberately changed on port,
 * not carried over verbatim:
 *
 * 1. Real ledger valuation, section-aware. The prototype's mock
 *    `ledgerBalance()` returned one same-shaped random number for every
 *    ledger/period pair regardless of accounting nature. Real ledgers are
 *    not uniform: a Balance-Sheet-side ledger (anc/ac/eq/lnc/lc) is a
 *    cumulative balance as of a given month (closingBalance()); a P&L-side
 *    ledger (inc/exp) is that single month's movement (monthNet()) — same
 *    distinction tb-engine.ts's aggregateByNote() already makes for every
 *    other report in this app. Mixing them up would make a "Cash & Bank"
 *    line show one month's movement instead of its running balance.
 *
 * 2. A real, confirmed bug in the reference engine: its subtotal rollup
 *    reset an accumulator to zero after EVERY subtotal, unconditionally —
 *    so a cascading waterfall (Total Income -> Gross Profit -> EBITDA ->
 *    PBT, the reference's own worked example) could never actually
 *    cascade; each subtotal only ever totaled the detail rows immediately
 *    above it, not the running result. Fixed here with an explicit,
 *    per-subtotal `resetsAfter` flag (default false = keep cascading,
 *    matching how a real management P&L waterfall works) — see
 *    report_lines.resets_after's own schema comment for the full reasoning
 *    on why an inferred/heuristic reset point doesn't work for both a
 *    single cascading P&L and a combined multi-statement layout.
 *
 * 3. Ledgers are mapped by NAME, not by a stable row id — tb_ledgers rows
 *    are re-created on every Zoho/Excel sync (new tb_uploads.id each time),
 *    so a saved mapping keyed to a specific row would silently go stale on
 *    the very next sync. ledger_name is what stays stable, same reasoning
 *    lib/services/zoho.ts already relies on for customerRevMap/
 *    vendorExpenseMap.
 *
 * Validation rules (unmapped lines, duplicate labels, a ledger double-
 * mapped, sign vs. section mismatch, orphan/empty subtotals, a header
 * section missing its closing total, no %-base line set) are a faithful
 * port of the reference's validation.ts — that logic was sound and needed
 * no correction, just Section (7-way: anc/ac/eq/lnc/lc/inc/exp) in place of
 * the reference's coarser 6-bucket NoteKey mock.
 */

import { monthNet, closingBalance, type TbLedgerRow, type Section } from './tb-engine';

export type LineType = 'detail' | 'subtotal' | 'header';

export interface ReportLine {
  id: string;
  templateId: string;
  parentLineId: string | null;
  label: string;
  sequence: number;
  lineType: LineType;
  /** +1 adds, -1 subtracts into the running total. */
  sign: 1 | -1;
  isPercentBase: boolean;
  /** Subtotal-only — see this file's header comment and report_lines.resets_after's schema comment. */
  resetsAfter: boolean;
}

export interface ReportTemplate {
  id: string;
  companyId: string;
  name: string;
  createdBy: string | null;
  clonedFromTemplateId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** report_line_id -> real ledger_name[] mapped to that line. */
export type LineLedgerMap = Record<string, string[]>;

export const LINE_TYPE_LABELS: Record<LineType, string> = {
  detail: 'Detail',
  subtotal: 'Subtotal',
  header: 'Header',
};

export const SECTION_LABELS: Record<Section, string> = {
  anc: 'Non-Current Assets',
  ac: 'Current Assets',
  eq: 'Equity',
  lnc: 'Non-Current Liabilities',
  lc: 'Current Liabilities',
  inc: 'Income',
  exp: 'Expenses',
};

const BS_SECTIONS = new Set<Section>(['anc', 'ac', 'eq', 'lnc', 'lc']);

/** Depth in the parent chain, for indentation display only — value computation below deliberately does NOT use this (see the file header comment on the resetsAfter fix). */
export function lineDepth(line: ReportLine, all: ReportLine[]): number {
  const byId = new Map(all.map((l) => [l.id, l]));
  let depth = 0;
  let cur = line;
  while (cur.parentLineId && depth < 8) {
    const parent = byId.get(cur.parentLineId);
    if (!parent) break;
    cur = parent;
    depth += 1;
  }
  return depth;
}

export interface ReportRow {
  line: ReportLine;
  depth: number;
  /** Real rupees, one entry per selected month index. */
  values: number[];
  /** % of the template's %-base line, per month (undefined when no base is set). */
  percents?: (number | null)[];
}

/** A single month's real signed value for a detail line's mapped ledgers — BS-side ledgers use their cumulative closing balance as of that month, P&L-side ledgers use that month's own movement. A line whose mapped ledgers span both (flagged by validateTemplate's mixed_section_categories check) sums whichever each ledger's own section calls for. */
function detailMonthValue(ledgerRows: TbLedgerRow[], monthIndex: number, sign: 1 | -1): number {
  const total = ledgerRows.reduce((sum, row) => {
    const isBs = row.section ? BS_SECTIONS.has(row.section as Section) : false;
    return sum + (isBs ? closingBalance(row, monthIndex) : monthNet(row, monthIndex));
  }, 0);
  return total * sign;
}

/**
 * Computes real signed values per selected month index. Detail lines sum
 * their mapped ledgers (real data, see detailMonthValue above). Subtotals
 * snapshot a running total that accumulates across the whole line sequence
 * and only resets where a subtotal explicitly says `resetsAfter` — this is
 * the corrected replacement for the reference engine's always-reset bug
 * (see this file's header comment).
 */
export function computeStatementReport(
  lines: ReportLine[],
  lineLedgerMap: LineLedgerMap,
  ledgersByName: Map<string, TbLedgerRow>,
  monthIndices: number[],
): ReportRow[] {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const sorted = [...lines].sort((a, b) => a.sequence - b.sequence);
  const zeros = () => monthIndices.map(() => 0);

  const values = new Map<string, number[]>();
  let running: number[] = zeros();

  sorted.forEach((line) => {
    if (line.lineType === 'header') {
      values.set(line.id, zeros());
      return;
    }
    if (line.lineType === 'detail') {
      const names = lineLedgerMap[line.id] ?? [];
      const rows = names
        .map((n) => ledgersByName.get(n))
        .filter((r): r is TbLedgerRow => Boolean(r));
      const v = monthIndices.map((mi) => detailMonthValue(rows, mi, line.sign));
      values.set(line.id, v);
      running = running.map((x, i) => x + (v[i] ?? 0));
      return;
    }
    // subtotal — snapshot the running total as-is, then reset only if this line says to.
    values.set(line.id, [...running]);
    if (line.resetsAfter) running = zeros();
  });

  const base = lines.find((l) => l.isPercentBase);
  const baseValues = base ? values.get(base.id) : undefined;

  return sorted.map((line) => {
    const v = values.get(line.id) ?? zeros();
    const row: ReportRow = { line, depth: lineDepth(line, lines), values: v };
    if (baseValues && line.lineType !== 'header') {
      row.percents = v.map((x, i) => {
        const b = baseValues[i];
        return b ? (x / b) * 100 : null;
      });
    }
    return row;
  });
}

// ── Validation ──────────────────────────────────────────────────────────

export type IssueSeverity = 'error' | 'warning';

export type IssueCode =
  | 'unmapped_detail'
  | 'empty_label'
  | 'duplicate_label'
  | 'ledger_double_counted'
  | 'mixed_section_categories'
  | 'sign_mismatch'
  | 'no_subtotal'
  | 'empty_subtotal'
  | 'group_without_subtotal'
  | 'no_percent_base';

export interface ValidationIssue {
  code: IssueCode;
  severity: IssueSeverity;
  title: string;
  detail: string;
  lineIds: string[];
}

export interface ValidationResult {
  issues: ValidationIssue[];
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  ok: boolean;
}

/** Sections that normally reduce a running total when included in a waterfall (expense- and liability-like). */
const NEGATIVE_SECTIONS = new Set<Section>(['exp', 'lc', 'lnc']);

/**
 * Pre-save checks for a format: every detail line must feed from at least
 * one real ledger, signs should match the mapped ledgers' real nature, and
 * every subtotal/header section must have something to total.
 * `ledgerSectionByName` is the current company's real ledger_name -> Section
 * lookup (built by the caller from live tb_ledgers — this function stays a
 * pure, testable function with no DB access of its own, same convention as
 * every other computation in tb-engine.ts).
 */
export function validateTemplate(
  lines: ReportLine[],
  lineLedgerMap: LineLedgerMap,
  ledgerSectionByName: Map<string, Section | null>,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const detailLines = lines.filter((l) => l.lineType === 'detail');
  const subtotals = lines.filter((l) => l.lineType === 'subtotal');

  // --- unmapped ledgers ---------------------------------------------------
  const unmapped = detailLines.filter((l) => (lineLedgerMap[l.id] ?? []).length === 0);
  if (unmapped.length > 0) {
    issues.push({
      code: 'unmapped_detail',
      severity: 'error',
      title: `${unmapped.length} detail line${unmapped.length > 1 ? 's' : ''} without ledgers`,
      detail: `These lines will always show zero: ${unmapped.map((l) => l.label || '(untitled)').join(', ')}.`,
      lineIds: unmapped.map((l) => l.id),
    });
  }

  // --- labels ---------------------------------------------------------------
  const blank = lines.filter((l) => !l.label.trim());
  if (blank.length > 0) {
    issues.push({
      code: 'empty_label',
      severity: 'error',
      title: `${blank.length} line${blank.length > 1 ? 's' : ''} missing a label`,
      detail: 'Every row needs a name before the format can be run or shared.',
      lineIds: blank.map((l) => l.id),
    });
  }

  const seen = new Map<string, string[]>();
  lines.forEach((l) => {
    const key = l.label.trim().toLowerCase();
    if (!key) return;
    seen.set(key, [...(seen.get(key) ?? []), l.id]);
  });
  const dupes = [...seen.entries()].filter(([, ids]) => ids.length > 1);
  if (dupes.length > 0) {
    issues.push({
      code: 'duplicate_label',
      severity: 'warning',
      title: `${dupes.length} duplicate line label${dupes.length > 1 ? 's' : ''}`,
      detail: `Repeated names make exports ambiguous: ${dupes.map(([k]) => k).join(', ')}.`,
      lineIds: dupes.flatMap(([, ids]) => ids),
    });
  }

  // --- ledgers used on more than one line -----------------------------------
  const ledgerUse = new Map<string, string[]>();
  detailLines.forEach((l) => {
    (lineLedgerMap[l.id] ?? []).forEach((led) => {
      ledgerUse.set(led, [...(ledgerUse.get(led) ?? []), l.id]);
    });
  });
  const doubled = [...ledgerUse.entries()].filter(([, ids]) => ids.length > 1);
  if (doubled.length > 0) {
    issues.push({
      code: 'ledger_double_counted',
      severity: 'warning',
      title: `${doubled.length} ledger${doubled.length > 1 ? 's' : ''} mapped to multiple lines`,
      detail: `Amounts will be counted twice in totals: ${doubled.map(([led]) => led).join(', ')}.`,
      lineIds: doubled.flatMap(([, ids]) => ids),
    });
  }

  // --- sign rules -------------------------------------------------------------
  const mixed: string[] = [];
  const signMismatch: { id: string; label: string; expected: 1 | -1; section: Section }[] = [];
  detailLines.forEach((l) => {
    const sections = new Set(
      (lineLedgerMap[l.id] ?? [])
        .map((n) => ledgerSectionByName.get(n))
        .filter((s): s is Section => Boolean(s)),
    );
    if (sections.size > 1) mixed.push(l.id);
    if (sections.size === 1) {
      const section = [...sections][0]!;
      const expected: 1 | -1 = NEGATIVE_SECTIONS.has(section) ? -1 : 1;
      if (l.sign !== expected) signMismatch.push({ id: l.id, label: l.label, expected, section });
    }
  });

  if (mixed.length > 0) {
    issues.push({
      code: 'mixed_section_categories',
      severity: 'warning',
      title: `${mixed.length} line${mixed.length > 1 ? 's' : ''} mixes ledger categories`,
      detail:
        'A single line pulls from more than one accounting section (e.g. income and expenses), so its sign cannot be applied consistently.',
      lineIds: mixed,
    });
  }

  if (signMismatch.length > 0) {
    issues.push({
      code: 'sign_mismatch',
      severity: 'error',
      title: `${signMismatch.length} line${signMismatch.length > 1 ? 's' : ''} with an inconsistent sign`,
      detail: signMismatch
        .map(
          (m) =>
            `${m.label || '(untitled)'} maps to ${SECTION_LABELS[m.section]} ledgers but is set to ${
              m.expected === -1 ? 'Add' : 'Subtract'
            } — expected ${m.expected === -1 ? 'Subtract' : 'Add'}.`,
        )
        .join(' '),
      lineIds: signMismatch.map((m) => m.id),
    });
  }

  // --- required subtotals ------------------------------------------------------
  if (detailLines.length > 0 && subtotals.length === 0) {
    issues.push({
      code: 'no_subtotal',
      severity: 'error',
      title: 'No subtotal line',
      detail: 'A format needs at least one subtotal so detail rows roll up to a result.',
      lineIds: [],
    });
  }

  const sortedLines = [...lines].sort((a, b) => a.sequence - b.sequence);
  const emptySubtotals: ReportLine[] = [];
  let pending = 0;
  sortedLines.forEach((l) => {
    if (l.lineType === 'detail') pending += 1;
    else if (l.lineType === 'subtotal') {
      if (pending === 0) emptySubtotals.push(l);
      pending = 0;
    }
  });
  if (emptySubtotals.length > 0) {
    issues.push({
      code: 'empty_subtotal',
      severity: 'error',
      title: `${emptySubtotals.length} subtotal${emptySubtotals.length > 1 ? 's' : ''} with nothing to total`,
      detail: `No detail lines sit above these subtotals: ${emptySubtotals.map((s) => s.label || '(untitled)').join(', ')}.`,
      lineIds: emptySubtotals.map((s) => s.id),
    });
  }

  // header groups: rows between a header and the next header must end in a subtotal
  const headerGroups: { headerId: string; label: string; members: ReportLine[] }[] = [];
  let current: { headerId: string; label: string; members: ReportLine[] } | null = null;
  sortedLines.forEach((l) => {
    if (l.lineType === 'header') {
      if (current) headerGroups.push(current);
      current = { headerId: l.id, label: l.label, members: [] };
      return;
    }
    if (current) current.members.push(l);
  });
  if (current) headerGroups.push(current);

  const groupsMissingTotal = headerGroups.filter(
    (g) => g.members.length > 0 && !g.members.some((m) => m.lineType === 'subtotal'),
  );
  if (groupsMissingTotal.length > 0) {
    issues.push({
      code: 'group_without_subtotal',
      severity: 'warning',
      title: `${groupsMissingTotal.length} section${groupsMissingTotal.length > 1 ? 's' : ''} without a subtotal`,
      detail: `Sections usually close with a total: ${groupsMissingTotal.map((g) => g.label || '(untitled)').join(', ')}.`,
      lineIds: groupsMissingTotal.map((g) => g.headerId),
    });
  }

  if (lines.length > 0 && !lines.some((l) => l.isPercentBase)) {
    issues.push({
      code: 'no_percent_base',
      severity: 'warning',
      title: 'No % base line marked',
      detail: 'Mark a line (usually revenue) as the % base to enable percent-of-base columns.',
      lineIds: [],
    });
  }

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  return { issues, errors, warnings, ok: errors.length === 0 };
}

// ── Presets ─────────────────────────────────────────────────────────────

export interface PresetLine {
  label: string;
  type: LineType;
  sign?: 1 | -1;
  base?: boolean;
  resetsAfter?: boolean;
  /** auto-map every real ledger in these sections */
  sections?: Section[];
  /** auto-map every real ledger whose name contains any of these (case-insensitive) */
  match?: string[];
}

export interface FormatPreset {
  id: string;
  name: string;
  summary: string;
  lines: PresetLine[];
}

/**
 * Starter structures so a new format is one click away instead of a blank
 * canvas. Keyword lists are drawn from this app's own ledger_master seed
 * vocabulary (db/init.ts) plus common real Zoho ledger naming patterns
 * observed on a live synced company — not the reference prototype's
 * fictional ledger names ("Raw Material Consumed", "Direct Labour"), which
 * wouldn't match anything in a real services-company chart of accounts.
 * Ledgers are pre-mapped by section/keyword at creation time and stay fully
 * editable afterwards — see resolvePresetLedgers().
 */
export const FORMAT_PRESETS: FormatPreset[] = [
  {
    id: 'preset_mgmt_pl',
    name: 'Management P&L',
    summary: 'Revenue → Gross Profit → EBITDA → PBT, cascading, with % of income',
    lines: [
      { label: 'Revenue', type: 'header' },
      { label: 'Operating Revenue', type: 'detail', match: ['revenue', 'sales', 'service'] },
      { label: 'Other Income', type: 'detail', match: ['other income', 'interest income', 'dividend', 'forex gain'] },
      { label: 'Total Income', type: 'subtotal', base: true },
      { label: 'Direct Costs', type: 'header' },
      { label: 'Cost of Services', type: 'detail', sign: -1, match: ['subcontract', 'cloud', 'infrastructure', 'data cent', 'technical consumable'] },
      { label: 'Gross Profit', type: 'subtotal' },
      { label: 'Operating Expenses', type: 'header' },
      { label: 'People Cost', type: 'detail', sign: -1, match: ['salar', 'wages', 'bonus', 'incentive', 'pf ', 'esic', 'staff welfare', 'gratuity', 'leave encashment'] },
      { label: 'Facility & Admin', type: 'detail', sign: -1, match: ['rent', 'utilit', 'power', 'admin', 'office expense', 'insurance', 'communication', 'internet'] },
      { label: 'Sales & Marketing', type: 'detail', sign: -1, match: ['marketing', 'travel', 'conveyance', 'business promotion'] },
      { label: 'Professional Fees', type: 'detail', sign: -1, match: ['professional', 'legal', 'consult'] },
      { label: 'EBITDA', type: 'subtotal' },
      { label: 'Below the Line', type: 'header' },
      { label: 'Depreciation & Amortisation', type: 'detail', sign: -1, match: ['depreciation', 'amortis', 'amortiz'] },
      { label: 'Finance Costs', type: 'detail', sign: -1, match: ['interest on', 'bank charge', 'processing fee', 'finance cost', 'foreign exchange loss'] },
      { label: 'Profit Before Tax', type: 'subtotal', resetsAfter: true },
    ],
  },
  {
    id: 'preset_bs',
    name: 'Balance Sheet summary',
    summary: 'Assets and Equity & Liabilities with totals',
    lines: [
      { label: 'Assets', type: 'header' },
      { label: 'Non-Current Assets', type: 'detail', sections: ['anc'] },
      { label: 'Current Assets', type: 'detail', sections: ['ac'] },
      { label: 'Total Assets', type: 'subtotal', base: true, resetsAfter: true },
      { label: 'Equity & Liabilities', type: 'header' },
      { label: 'Equity', type: 'detail', sections: ['eq'] },
      { label: 'Non-Current Liabilities', type: 'detail', sections: ['lnc'] },
      { label: 'Current Liabilities', type: 'detail', sections: ['lc'] },
      { label: 'Total Equity & Liabilities', type: 'subtotal' },
    ],
  },
  {
    id: 'preset_working_capital',
    name: 'Working capital view',
    summary: 'Receivables, inventory, cash vs. payables and short-term debt',
    lines: [
      { label: 'Current Assets', type: 'header' },
      { label: 'Trade Receivables', type: 'detail', match: ['receivable', 'debtor'] },
      { label: 'Inventory', type: 'detail', match: ['inventor', 'stock-in-trade', 'work-in-progress', 'raw material'] },
      { label: 'Cash & Bank', type: 'detail', match: ['cash', 'bank'] },
      { label: 'Gross Working Capital', type: 'subtotal', base: true },
      { label: 'Current Liabilities', type: 'header' },
      { label: 'Trade Payables', type: 'detail', sign: -1, match: ['payable', 'creditor'] },
      { label: 'Short-Term Borrowings', type: 'detail', sign: -1, match: [' od', 'overdraft', 'working capital loan', 'business loan'] },
      { label: 'Net Working Capital', type: 'subtotal' },
    ],
  },
  {
    id: 'preset_fpa_variance',
    name: 'FP&A — Period variance',
    summary: 'P&L lines laid out for MoM / QoQ variance reviews',
    lines: [
      { label: 'Top Line', type: 'header' },
      { label: 'Revenue', type: 'detail', sections: ['inc'] },
      { label: 'Total Revenue', type: 'subtotal', base: true },
      { label: 'Direct Costs', type: 'header' },
      { label: 'Cost of Services', type: 'detail', sign: -1, match: ['subcontract', 'cloud', 'infrastructure', 'data cent'] },
      { label: 'Contribution Margin', type: 'subtotal' },
      { label: 'Opex', type: 'header' },
      { label: 'People', type: 'detail', sign: -1, match: ['salar', 'wages', 'bonus'] },
      { label: 'G&A', type: 'detail', sign: -1, match: ['rent', 'power', 'professional', 'admin', 'insurance'] },
      { label: 'Sales & Marketing', type: 'detail', sign: -1, match: ['marketing', 'travel'] },
      { label: 'EBITDA', type: 'subtotal' },
      { label: 'Non-Operating', type: 'header' },
      { label: 'D&A + Finance Cost', type: 'detail', sign: -1, match: ['depreciation', 'amortis', 'interest on', 'finance cost'] },
      { label: 'Net Result', type: 'subtotal', resetsAfter: true },
    ],
  },
  {
    id: 'preset_fpa_opex',
    name: 'FP&A — Opex by category',
    summary: 'Every expense section as % of income, for cost control reviews',
    lines: [
      { label: 'Income', type: 'header' },
      { label: 'Total Income', type: 'detail', sections: ['inc'] },
      { label: 'Income Base', type: 'subtotal', base: true },
      { label: 'Operating Expenses', type: 'header' },
      { label: 'People Cost', type: 'detail', sign: -1, match: ['salar', 'wages', 'bonus', 'incentive', 'pf ', 'esic', 'gratuity'] },
      { label: 'Facility & Admin', type: 'detail', sign: -1, match: ['rent', 'utilit', 'power', 'admin', 'insurance', 'communication'] },
      { label: 'Sales & Marketing', type: 'detail', sign: -1, match: ['marketing', 'travel', 'conveyance'] },
      { label: 'Professional & Other', type: 'detail', sign: -1, match: ['professional', 'legal', 'consult', 'csr'] },
      { label: 'Total Opex', type: 'subtotal' },
    ],
  },
  {
    id: 'preset_revenue',
    name: 'Revenue breakdown',
    summary: 'Operating vs. other income, ready for further edits',
    lines: [
      { label: 'Income', type: 'header' },
      { label: 'Operating Revenue', type: 'detail', match: ['revenue', 'sales', 'service'] },
      { label: 'Other Income', type: 'detail', match: ['other income', 'interest income', 'dividend', 'forex gain'] },
      { label: 'Total Income', type: 'subtotal', base: true },
    ],
  },
];

/** Real ledger names (from the company's currently loaded ledgers) matching a preset line's section/keyword rules. */
export function resolvePresetLedgers(presetLine: PresetLine, ledgers: TbLedgerRow[]): string[] {
  if (presetLine.type !== 'detail') return [];
  const ids = new Set<string>();
  ledgers.forEach((l) => {
    if (presetLine.sections?.includes(l.section as Section)) ids.add(l.ledger_name);
    const name = l.ledger_name.toLowerCase();
    if (presetLine.match?.some((m) => name.includes(m.toLowerCase()))) ids.add(l.ledger_name);
  });
  return [...ids];
}
