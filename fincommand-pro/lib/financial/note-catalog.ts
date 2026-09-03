/**
 * The canonical list of valid IND AS Schedule III notes a ledger can be
 * classified under — the single source of truth for the Notes to Accounts
 * drag-and-drop reclassification feature (both the drop-target list the UI
 * offers and the server-side validation of what a client is allowed to set
 * a ledger's note/section to). Deliberately plain data with no imports, so
 * it's safe to use from both client components and API route handlers.
 *
 * Sourced from the same note definitions already established and verified
 * elsewhere in this engine — lib/financial/sample-data.ts's BS_LINES (the
 * standard Balance Sheet note skeleton) for notes 1-19/20/21/23, and
 * tb-engine.ts's computePL()/computeMIS() noteSum(20..26) calls for the
 * P&L notes — not a new, separately-invented list.
 *
 * Three notes (13, 19, 20) carry a `treasuryType` because computeTreasury()
 * groups ledgers by that field, not by note_no alone — dropping a ledger
 * onto one of these sets both. Note 19 (Cash and Cash Equivalents) covers
 * three real treasury sub-types (cash / bank current / bank savings) that
 * this note-level catalog can't individually distinguish as separate drop
 * targets without fragmenting the Notes to Accounts card layout; the API
 * route resolves that ambiguity by preserving whichever of the three the
 * dragged ledger already had, only defaulting to 'bank_ca' when it wasn't
 * already one of them (see reclassify/route.ts's own comment).
 */
export interface NoteCatalogEntry {
  note_no: number;
  note_name: string;
  section: 'anc' | 'ac' | 'eq' | 'lnc' | 'lc' | 'inc' | 'exp';
  /** Set only for the three treasury-tracked notes (13 = Mutual Funds, 19 = Cash & Bank, 20 = Fixed Deposits) — null for every other note. */
  treasuryType: 'cash' | 'bank_ca' | 'bank_sb' | 'fd' | 'mf' | null;
}

export const NOTE_CATALOG: NoteCatalogEntry[] = [
  // ── Non-current assets ──
  { note_no: 10, note_name: 'Property, Plant and Equipment', section: 'anc', treasuryType: null },
  { note_no: 11, note_name: 'Right-of-Use Assets', section: 'anc', treasuryType: null },
  { note_no: 12, note_name: 'Intangible Assets', section: 'anc', treasuryType: null },
  { note_no: 14, note_name: 'Other Non-Current Assets', section: 'anc', treasuryType: null },
  // ── Current assets ──
  { note_no: 13, note_name: 'Investments Current', section: 'ac', treasuryType: 'mf' },
  { note_no: 15, note_name: 'Inventories', section: 'ac', treasuryType: null },
  { note_no: 16, note_name: 'Trade Receivables', section: 'ac', treasuryType: null },
  { note_no: 19, note_name: 'Cash and Cash Equivalents', section: 'ac', treasuryType: 'bank_ca' },
  { note_no: 20, note_name: 'Bank Balances (FDs)', section: 'ac', treasuryType: 'fd' },
  { note_no: 21, note_name: 'Loans & Advances', section: 'ac', treasuryType: null },
  { note_no: 23, note_name: 'Other Current Assets', section: 'ac', treasuryType: null },
  // ── Equity ──
  { note_no: 1, note_name: 'Share Capital', section: 'eq', treasuryType: null },
  { note_no: 2, note_name: 'Other Equity', section: 'eq', treasuryType: null },
  // ── Non-current liabilities ──
  { note_no: 3, note_name: 'Long-Term Borrowings', section: 'lnc', treasuryType: null },
  { note_no: 4, note_name: 'Lease Liabilities', section: 'lnc', treasuryType: null },
  { note_no: 5, note_name: 'Deferred Tax', section: 'lnc', treasuryType: null },
  { note_no: 6, note_name: 'Long-Term Provisions', section: 'lnc', treasuryType: null },
  // ── Current liabilities ──
  { note_no: 7, note_name: 'Trade Payables', section: 'lc', treasuryType: null },
  { note_no: 8, note_name: 'Other Financial Liabilities', section: 'lc', treasuryType: null },
  { note_no: 9, note_name: 'Short-Term Borrowings', section: 'lc', treasuryType: null },
  { note_no: 17, note_name: 'Other Current Liabilities', section: 'lc', treasuryType: null },
  // ── P&L: Income ──
  { note_no: 20, note_name: 'Revenue from Operations', section: 'inc', treasuryType: null },
  { note_no: 21, note_name: 'Other Income', section: 'inc', treasuryType: null },
  // ── P&L: Expenses ──
  { note_no: 22, note_name: 'Cost of Services', section: 'exp', treasuryType: null },
  { note_no: 23, note_name: 'Employee Benefits', section: 'exp', treasuryType: null },
  { note_no: 24, note_name: 'Finance Costs', section: 'exp', treasuryType: null },
  { note_no: 25, note_name: 'Depreciation & Amortisation', section: 'exp', treasuryType: null },
  { note_no: 26, note_name: 'Other Expenses', section: 'exp', treasuryType: null },
];

/** Note 20 means two different things depending on section (Revenue on the P&L side, Bank Balances/FDs on the Balance Sheet side) — same collision Notes to Accounts' own `bs_${no}`/`pl_${no}` key already disambiguates. Looks up by both. */
export function findNoteCatalogEntry(note_no: number, section: string): NoteCatalogEntry | undefined {
  return NOTE_CATALOG.find(n => n.note_no === note_no && n.section === section);
}

const BS_SECTIONS = new Set(['anc', 'ac', 'eq', 'lnc', 'lc']);
export const isBSSection = (section?: string | null): boolean => BS_SECTIONS.has(section || '');
