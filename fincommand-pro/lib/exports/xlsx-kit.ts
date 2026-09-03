'use client';

/**
 * Shared primitives for the bespoke, per-tab Excel exports (overview-xlsx.ts,
 * cashflow-xlsx.ts, and future tab-specific exports). Unlike the generic
 * per-section exporter (lib/exports/xlsx.ts), sheets built with this kit
 * hold real numbers with genuine Excel accounting number formats (`z`) —
 * `#,##0.00;[Red](#,##0.00)` for amounts, `0.0%;[Red](0.0%)` for percentages
 * — Excel's own native negative-red-in-parentheses rendering, so the values
 * stay live numbers a user can chart, sum, or build formulas against.
 */
import * as XLSX from 'xlsx';
import type { DisplayUnit } from '@/lib/utils/format';

export const ACC_FMT = '#,##0.00;[Red](#,##0.00)';
export const PCT_FMT = '0.0%;[Red](0.0%)';
export const DEFAULT_COMPANY_NAME = 'Sample Company (Demo Data)';

const UNIT_DIVISOR: Record<DisplayUnit, number> = { Lakhs: 100000, Thousands: 1000, Crores: 10000000 };

/** Converts raw rupees to the selected table unit — the same three divisors fl()/fn() use on-screen, so an exported workbook always matches whatever unit was selected in the topbar when it was downloaded. */
export const toUnit = (rupees: number, unit: DisplayUnit = 'Lakhs') => rupees / UNIT_DIVISOR[unit];

export type CellVal = string | number | null;
export interface SheetRow { cells: CellVal[]; formats?: (string | null)[]; bold?: boolean; }

export function buildSheet(wb: XLSX.WorkBook, sheetName: string, rows: SheetRow[], colWidths: number[]) {
  const aoa = rows.map(r => r.cells.map(c => (c === null ? '' : c)));
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  rows.forEach((row, ri) => {
    row.cells.forEach((val, ci) => {
      const ref = XLSX.utils.encode_cell({ r: ri, c: ci });
      const cell = ws[ref];
      if (!cell) return;
      const fmt = row.formats?.[ci];
      if (fmt && typeof val === 'number') cell.z = fmt;
      if (row.bold) {
        cell.s = { font: { bold: true } }; // honored only by editors that read cell.s (community xlsx writer doesn't emit styles) — harmless no-op otherwise, kept for forward-compat.
      }
    });
  });

  ws['!cols'] = colWidths.map(w => ({ wch: w }));
  let name = sheetName.slice(0, 31);
  let n = 1;
  while (wb.SheetNames.includes(name)) { const suf = `_${n++}`; name = `${sheetName.slice(0, 31 - suf.length)}${suf}`; }
  XLSX.utils.book_append_sheet(wb, ws, name);
}

export function buildInfoSheet(wb: XLSX.WorkBook, opts: {
  companyName: string; fyFullLabel: string; yearType: string; periodLabel: string; generatedAt: string;
}) {
  const info: SheetRow[] = [
    { cells: ['FinCommand Pro — Report Info'] },
    { cells: [] },
    { cells: ['Company', opts.companyName] },
    { cells: ['Reporting Year', opts.fyFullLabel] },
    { cells: ['Year Type', opts.yearType] },
    { cells: ['Reporting Period', opts.periodLabel] },
    { cells: ['IND AS Standard', 'Schedule III Division II Compliant'] },
    { cells: ['Generated At', opts.generatedAt] },
  ];
  buildSheet(wb, 'Info', info, [25, 45]);
}
