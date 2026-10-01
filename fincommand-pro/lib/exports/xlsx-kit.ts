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
import * as ExcelJS from 'exceljs';
import type { DisplayUnit } from '@/lib/utils/format';

export const ACC_FMT = '#,##0.00;[Red](#,##0.00)';
export const PCT_FMT = '0.0%;[Red](0.0%)';
export const DEFAULT_COMPANY_NAME = 'Sample Company (Demo Data)';

const UNIT_DIVISOR: Record<DisplayUnit, number> = { Lakhs: 100000, Thousands: 1000, Crores: 10000000 };

/** Converts raw rupees to the selected table unit — the same three divisors fl()/fn() use on-screen, so an exported workbook always matches whatever unit was selected in the topbar when it was downloaded. */
export const toUnit = (rupees: number, unit: DisplayUnit = 'Lakhs') => rupees / UNIT_DIVISOR[unit];

export type CellVal = string | number | null;
export interface SheetRow { cells: CellVal[]; formats?: (string | null)[]; bold?: boolean; }

export function buildSheet(wb: ExcelJS.Workbook, sheetName: string, rows: SheetRow[], colWidths: number[]) {
  let name = sheetName.slice(0, 31);
  let n = 1;
  while (wb.worksheets.some(s => s.name === name)) {
    const suf = `_${n++}`; 
    name = `${sheetName.slice(0, 31 - suf.length)}${suf}`;
  }
  
  const ws = wb.addWorksheet(name);
  ws.columns = colWidths.map(w => ({ width: w }));

  rows.forEach((row) => {
    const wsRow = ws.addRow(row.cells.map(c => c === null ? '' : c));
    row.cells.forEach((val, ci) => {
      const cell = wsRow.getCell(ci + 1);
      const fmt = row.formats?.[ci];
      if (fmt && typeof val === 'number') {
        cell.numFmt = fmt;
      }
      if (row.bold) {
        cell.font = { bold: true };
      }
    });
  });
}

export function buildInfoSheet(wb: ExcelJS.Workbook, opts: {
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

export async function downloadWorkbook(wb: ExcelJS.Workbook, filename: string) {
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
