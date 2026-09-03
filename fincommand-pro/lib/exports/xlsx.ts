'use client';

import * as XLSX from 'xlsx';
import type { ReportBundle } from '@/lib/dashboard/types';
import { getExportTables, metaRows, type ExportTable } from './tables';
import { getFyLabel, getFyShortLabel, type DisplayUnit, type CurrencyCode } from '@/lib/utils/format';
import { exportOverviewXlsx } from './overview-xlsx';
import { exportCashFlowXlsx } from './cashflow-xlsx';
import { exportMisXlsx } from './mis-xlsx';
import { exportBsXlsx } from './bs-xlsx';
import { exportPlXlsx } from './pl-xlsx';
import { exportNotesXlsx } from './notes-xlsx';
import { exportTreasuryXlsx } from './treasury-xlsx';

const ALL_SECTIONS = [
  'overview',
  'mis',
  'bs',
  'pl',
  'notes',
  'treasury',
  'cashflow',
  'ratios',
  'workingcapital',
  'alerts',
  'compliance',
  'boardpack',
  'scenario',
];

function tablesToSheet(wb: XLSX.WorkBook, table: ExportTable, bundle: ReportBundle, companyName: string) {
  const yearType = bundle.period_params?.yearType || 'FY';
  const fyLabel = getFyLabel(bundle.financial_year, yearType);
  const periodLabel = bundle.period_label;

  const headerBlock = [
    ['FinCommand Pro — Corporate Financial Platform'],
    [table.title],
    [`Company: ${companyName} | Period: ${periodLabel} | ${yearType}: ${fyLabel} | IND AS Schedule III`],
    [], // Spacer row
    table.columns,
  ];

  const aoa = [...headerBlock, ...table.rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Dynamic Column Width Calculation (prevents ### truncation in Excel)
  const colWidths = table.columns.map((colName, colIdx) => {
    let maxLen = String(colName || '').length;
    table.rows.forEach(r => {
      const val = r[colIdx];
      if (val != null) {
        maxLen = Math.max(maxLen, String(val).length);
      }
    });
    return { wch: Math.min(Math.max(maxLen + 4, 16), 65) };
  });

  ws['!cols'] = colWidths;

  // Append sheet safely (ensure unique sheet name <= 31 chars)
  let baseName = table.sheetName.slice(0, 31);
  let sheetName = baseName;
  let counter = 1;
  while (wb.SheetNames.includes(sheetName)) {
    const suffix = `_${counter}`;
    sheetName = `${baseName.slice(0, 31 - suffix.length)}${suffix}`;
    counter++;
  }

  XLSX.utils.book_append_sheet(wb, ws, sheetName);
}

export function exportSectionXlsx(section: string, bundle: ReportBundle, companyName = 'Sample Company (Demo Data)', unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): void {
  // Executive Overview, Cash Flow, MIS, and Balance Sheet get bespoke
  // workbooks — real numbers with native Excel accounting number formats
  // (red/parens for negative) instead of the generic key/value dump every
  // other section uses. See overview-xlsx.ts / cashflow-xlsx.ts /
  // mis-xlsx.ts / bs-xlsx.ts.
  if (section === 'overview') {
    exportOverviewXlsx(bundle, companyName, unit, compare, currency);
    return;
  }
  if (section === 'cashflow') {
    exportCashFlowXlsx(bundle, companyName, unit, compare, currency);
    return;
  }
  if (section === 'mis') {
    exportMisXlsx(bundle, companyName, unit, compare, currency);
    return;
  }
  if (section === 'bs') {
    exportBsXlsx(bundle, companyName, unit, compare, currency);
    return;
  }
  if (section === 'pl') {
    exportPlXlsx(bundle, companyName, unit, compare, currency);
    return;
  }
  if (section === 'notes') {
    exportNotesXlsx(bundle, companyName, unit, compare, currency);
    return;
  }
  if (section === 'treasury') {
    exportTreasuryXlsx(bundle, companyName, unit, compare, currency);
    return;
  }

  const wb = XLSX.utils.book_new();
  const tables = getExportTables(section, bundle, unit, compare, currency);
  tables.forEach(t => tablesToSheet(wb, t, bundle, companyName));

  const metaSheet = XLSX.utils.aoa_to_sheet([
    ['FinCommand Pro — Report Summary Info'],
    [],
    ...metaRows(bundle, companyName, currency),
  ]);
  metaSheet['!cols'] = [{ wch: 25 }, { wch: 45 }];
  XLSX.utils.book_append_sheet(wb, metaSheet, 'Info');

  const yearType = bundle.period_params?.yearType || 'FY';
  const fyShort = getFyShortLabel(bundle.financial_year, yearType);
  XLSX.writeFile(wb, `FinCommandPro_${section.toUpperCase()}_${fyShort}.xlsx`);
}

export function exportAllXlsx(bundle: ReportBundle, companyName = 'Sample Company (Demo Data)', unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): void {
  const wb = XLSX.utils.book_new();
  ALL_SECTIONS.forEach(section => {
    getExportTables(section, bundle, unit, compare, currency).forEach(t => tablesToSheet(wb, t, bundle, companyName));
  });

  const metaSheet = XLSX.utils.aoa_to_sheet([
    ['FinCommand Pro — Complete Financial Suite Export'],
    [],
    ...metaRows(bundle, companyName, currency),
  ]);
  metaSheet['!cols'] = [{ wch: 25 }, { wch: 45 }];
  XLSX.utils.book_append_sheet(wb, metaSheet, 'Info');

  const yearType = bundle.period_params?.yearType || 'FY';
  const fyShort = getFyShortLabel(bundle.financial_year, yearType);
  XLSX.writeFile(wb, `FinCommandPro_AllReports_${fyShort}.xlsx`);
}
