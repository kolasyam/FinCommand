/**
 * FinCommand Pro — CY (Calendar Year) Ledger Merger
 *
 * For Indian-FY companies (Apr–Mar), a Calendar Year straddles two fiscal years:
 *
 *   CY YYYY:
 *     Jan–Mar YYYY  ←  prevFY  (the FY ending 31 Mar YYYY)  →  m10, m11, m12
 *     Apr–Dec YYYY  ←  nextFY  (the FY starting 1 Apr YYYY) →  m1 … m9
 *
 * Examples
 *   CY2024 → prevFY = FY24 (Apr 2023–Mar 2024), nextFY = FY25 (Apr 2024–Mar 2025)
 *   CY2025 → prevFY = FY25 (Apr 2024–Mar 2025), nextFY = FY26 (not yet uploaded → zeros)
 *
 * Usage
 *   const merged = mergeCyLedgers(prevFyRows, nextFyRows);
 *   computeMIS(merged, { periodType: 'annual', yearType: 'CY' });
 *
 * The merged rows feed directly into tb-engine.ts (no engine changes) because
 * the engine's month indices are 0-based (m1…m12 = index 0…11) regardless of
 * whether they represent FY months or CY months. When yearType='CY' the engine
 * already labels index 0 as "Jan", index 3 as "Apr", etc. — which now correctly
 * matches the spliced data.
 */

import { closingBalance, type TbLedgerRow } from './tb-engine';

type Num = number | string | null | undefined;

/** Read a raw numeric field from a row (returns 0 if row is null or field absent). */
const getField = (row: TbLedgerRow | null, field: string): Num =>
  row ? ((row[field] as Num) ?? 0) : 0;

/**
 * Determine whether a ledger row belongs to a Balance Sheet section.
 * BS rows use cumulative `closingBalance`; P&L rows use flow-based `periodNet`.
 */
const isBsSection = (section: string | null | undefined): boolean =>
  ['anc', 'ac', 'eq', 'lnc', 'lc'].includes(section || '');

/**
 * Merge two FY ledger row arrays into a single CY ledger row array.
 *
 * @param prevFyRows  Rows from the FY whose m10–m12 cover Jan–Mar of the CY year.
 *                    e.g. FY24 ledgers for CY2024.
 * @param nextFyRows  Rows from the FY whose m1–m9 cover Apr–Dec of the CY year.
 *                    e.g. FY25 ledgers for CY2024.
 *                    Pass [] when the next FY has not yet been uploaded — those
 *                    months will be zero and the CY view will show only Jan–Mar data.
 * @returns Synthetic TbLedgerRow[] with 12 months mapped to Jan–Dec of the CY year.
 */
export function mergeCyLedgers(
  prevFyRows: TbLedgerRow[],
  nextFyRows: TbLedgerRow[],
): TbLedgerRow[] {
  // ── Build lookup maps (ledger_code primary, ledger_name fallback) ──
  const prevMap = new Map<string, TbLedgerRow>();
  const nextMap = new Map<string, TbLedgerRow>();

  for (const row of prevFyRows) {
    prevMap.set(row.ledger_code || row.ledger_name, row);
  }
  for (const row of nextFyRows) {
    nextMap.set(row.ledger_code || row.ledger_name, row);
  }

  // Union of all ledger keys present in either FY
  const allKeys = new Set([...prevMap.keys(), ...nextMap.keys()]);

  const merged: TbLedgerRow[] = [];

  for (const key of allKeys) {
    const prev = prevMap.get(key) ?? null;
    const next = nextMap.get(key) ?? null;
    // Use whichever row is present as the structural template (metadata fields)
    const template = (prev ?? next)!;

    // ── Opening balance for CY = balance at 31 Dec of (CY year − 1) ──
    // For BS rows: = closingBalance(prevFY, month-index 8) because
    //   FY month 9 = December (index 8 in 0-based), and the cumulative balance
    //   at the end of that month equals 31 Dec of the preceding calendar year.
    // For P&L rows: opening is always 0 (flow accounts reset each FY).
    let opDr = 0;
    let opCr = 0;

    if (isBsSection(template.section) && prev) {
      // closingBalance returns the signed net balance (positive = Dr-normal or Cr-normal)
      const netAtDec31 = closingBalance(prev, 8); // index 8 = FY month 9 = December
      if (template.normal_bal === 'Dr') {
        opDr = Math.max(0, netAtDec31);
        opCr = Math.max(0, -netAtDec31);
      } else {
        opCr = Math.max(0, netAtDec31);
        opDr = Math.max(0, -netAtDec31);
      }
    }

    // ── Month mapping ──────────────────────────────────────────────────────────
    //  CY  m1  Jan  ←  prevFY m10    CY  m2  Feb  ←  prevFY m11
    //  CY  m3  Mar  ←  prevFY m12
    //  CY  m4  Apr  ←  nextFY  m1    CY  m5  May  ←  nextFY  m2
    //  CY  m6  Jun  ←  nextFY  m3    CY  m7  Jul  ←  nextFY  m4
    //  CY  m8  Aug  ←  nextFY  m5    CY  m9  Sep  ←  nextFY  m6
    //  CY m10  Oct  ←  nextFY  m7    CY m11  Nov  ←  nextFY  m8
    //  CY m12  Dec  ←  nextFY  m9
    merged.push({
      ...template,
      op_dr: opDr,
      op_cr: opCr,

      // Jan–Mar from prevFY (m10, m11, m12)
      m1_dr: getField(prev, 'm10_dr'), m1_cr: getField(prev, 'm10_cr'),
      m2_dr: getField(prev, 'm11_dr'), m2_cr: getField(prev, 'm11_cr'),
      m3_dr: getField(prev, 'm12_dr'), m3_cr: getField(prev, 'm12_cr'),

      // Apr–Dec from nextFY (m1 … m9)
      m4_dr:  getField(next, 'm1_dr'),  m4_cr:  getField(next, 'm1_cr'),
      m5_dr:  getField(next, 'm2_dr'),  m5_cr:  getField(next, 'm2_cr'),
      m6_dr:  getField(next, 'm3_dr'),  m6_cr:  getField(next, 'm3_cr'),
      m7_dr:  getField(next, 'm4_dr'),  m7_cr:  getField(next, 'm4_cr'),
      m8_dr:  getField(next, 'm5_dr'),  m8_cr:  getField(next, 'm5_cr'),
      m9_dr:  getField(next, 'm6_dr'),  m9_cr:  getField(next, 'm6_cr'),
      m10_dr: getField(next, 'm7_dr'),  m10_cr: getField(next, 'm7_cr'),
      m11_dr: getField(next, 'm8_dr'),  m11_cr: getField(next, 'm8_cr'),
      m12_dr: getField(next, 'm9_dr'),  m12_cr: getField(next, 'm9_cr'),
    });
  }

  return merged;
}

/**
 * Derive the Calendar Year number from an FY's end_date (or start_date).
 * FY25 ends 2025-03-31  →  CY2025
 * FY24 ends 2024-03-31  →  CY2024
 */
export function cyYearFromFyDates(startDate: string, endDate?: string | null): number {
  if (endDate) return parseInt(endDate.slice(0, 4), 10);
  // Fallback: start_date + 1 year (Apr YYYY → CY YYYY+1)
  return parseInt(startDate.slice(0, 4), 10) + 1;
}

/**
 * CY-merge equivalent of mergeCyLedgers() for real per-customer revenue rows
 * (see lib/db/queries/reports.ts::loadCustomerRevenue). Customer revenue is a
 * pure flow metric (like P&L, no opening-balance concept), so this is just
 * the same Jan–Mar / Apr–Dec month splice without the BS opening-balance
 * branch mergeCyLedgers() needs.
 */
export function mergeCyCustomerRevenue<
  T extends { customer_name: string; zoho_customer_id?: string | null; m1: unknown; m2: unknown; m3: unknown; m4: unknown; m5: unknown; m6: unknown; m7: unknown; m8: unknown; m9: unknown; m10: unknown; m11: unknown; m12: unknown }
>(prevFyRows: T[], nextFyRows: T[]): { customer_name: string; zoho_customer_id: string | null; m: number[] }[] {
  const num = (v: unknown): number => parseFloat(String(v ?? '')) || 0;
  const keyOf = (r: T) => r.zoho_customer_id || r.customer_name;

  const prevMap = new Map<string, T>();
  const nextMap = new Map<string, T>();
  for (const row of prevFyRows) prevMap.set(keyOf(row), row);
  for (const row of nextFyRows) nextMap.set(keyOf(row), row);

  const allKeys = new Set([...prevMap.keys(), ...nextMap.keys()]);
  const merged: { customer_name: string; zoho_customer_id: string | null; m: number[] }[] = [];

  for (const key of allKeys) {
    const prev = prevMap.get(key) ?? null;
    const next = nextMap.get(key) ?? null;
    const template = (prev ?? next)!;

    merged.push({
      customer_name: template.customer_name,
      zoho_customer_id: template.zoho_customer_id ?? null,
      m: [
        // Jan–Mar from prevFY (m10, m11, m12)
        prev ? num(prev.m10) : 0, prev ? num(prev.m11) : 0, prev ? num(prev.m12) : 0,
        // Apr–Dec from nextFY (m1 … m9)
        next ? num(next.m1) : 0, next ? num(next.m2) : 0, next ? num(next.m3) : 0,
        next ? num(next.m4) : 0, next ? num(next.m5) : 0, next ? num(next.m6) : 0,
        next ? num(next.m7) : 0, next ? num(next.m8) : 0, next ? num(next.m9) : 0,
      ],
    });
  }

  return merged;
}
