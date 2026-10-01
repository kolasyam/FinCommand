'use client';

import * as ExcelJS from 'exceljs';
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
import { downloadWorkbook } from './xlsx-kit';

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

function tablesToSheet(wb: ExcelJS.Workbook, table: ExportTable, bundle: ReportBundle, companyName: string) {
  const yearType = bundle.period_params?.yearType || 'FY';
  const fyLabel = getFyLabel(bundle.financial_year, yearType);
  const periodLabel = bundle.period_label;

  let baseName = table.sheetName.slice(0, 31);
  let sheetName = baseName;
  let counter = 1;
  while (wb.worksheets.some(s => s.name === sheetName)) {
    const suffix = `_${counter}`;
    sheetName = `${baseName.slice(0, 31 - suffix.length)}${suffix}`;
    counter++;
  }

  const ws = wb.addWorksheet(sheetName);

  // Dynamic Column Width Calculation (prevents ### truncation in Excel)
  const colWidths = table.columns.map((colName, colIdx) => {
    let maxLen = String(colName || '').length;
    table.rows.forEach(r => {
      const val = r[colIdx];
      if (val != null) {
        maxLen = Math.max(maxLen, String(val).length);
      }
    });
    return Math.min(Math.max(maxLen + 4, 16), 65);
  });

  ws.columns = colWidths.map(w => ({ width: w }));

  const headerBlock = [
    ['FinCommand Pro — Corporate Financial Platform'],
    [table.title],
    [`Company: ${companyName} | Period: ${periodLabel} | ${yearType}: ${fyLabel} | IND AS Schedule III`],
    [], // Spacer row
    table.columns,
  ];

  const aoa = [...headerBlock, ...table.rows];
  ws.addRows(aoa);
}

export async function exportSectionXlsx(section: string, bundle: ReportBundle, companyName = 'Sample Company (Demo Data)', unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): Promise<void> {
  // Executive Overview, Cash Flow, MIS, and Balance Sheet get bespoke
  // workbooks — real numbers with native Excel accounting number formats
  // (red/parens for negative) instead of the generic key/value dump every
  // other section uses. See overview-xlsx.ts / cashflow-xlsx.ts /
  // mis-xlsx.ts / bs-xlsx.ts.
  if (section === 'overview') {
    return exportOverviewXlsx(bundle, companyName, unit, compare, currency);
  }
  if (section === 'cashflow') {
    return exportCashFlowXlsx(bundle, companyName, unit, compare, currency);
  }
  if (section === 'mis') {
    return exportMisXlsx(bundle, companyName, unit, compare, currency);
  }
  if (section === 'bs') {
    return exportBsXlsx(bundle, companyName, unit, compare, currency);
  }
  if (section === 'pl') {
    return exportPlXlsx(bundle, companyName, unit, compare, currency);
  }
  if (section === 'notes') {
    return exportNotesXlsx(bundle, companyName, unit, compare, currency);
  }
  if (section === 'treasury') {
    return exportTreasuryXlsx(bundle, companyName, unit, compare, currency);
  }

  const wb = new ExcelJS.Workbook();
  const tables = getExportTables(section, bundle, unit, compare, currency);
  tables.forEach(t => tablesToSheet(wb, t, bundle, companyName));

  const metaSheet = wb.addWorksheet('Info');
  metaSheet.columns = [{ width: 25 }, { width: 45 }];
  metaSheet.addRows([
    ['FinCommand Pro — Report Summary Info'],
    [],
    ...metaRows(bundle, companyName, currency),
  ]);

  const yearType = bundle.period_params?.yearType || 'FY';
  const fyShort = getFyShortLabel(bundle.financial_year, yearType);
  await downloadWorkbook(wb, `FinCommandPro_${section.toUpperCase()}_${fyShort}.xlsx`);
}

export async function exportAllXlsx(bundle: ReportBundle, companyName = 'Sample Company (Demo Data)', unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): Promise<void> {
  const wb = new ExcelJS.Workbook();
  ALL_SECTIONS.forEach(section => {
    getExportTables(section, bundle, unit, compare, currency).forEach(t => tablesToSheet(wb, t, bundle, companyName));
  });

  const metaSheet = wb.addWorksheet('Info');
  metaSheet.columns = [{ width: 25 }, { width: 45 }];
  metaSheet.addRows([
    ['FinCommand Pro — Complete Financial Suite Export'],
    [],
    ...metaRows(bundle, companyName, currency),
  ]);

  const yearType = bundle.period_params?.yearType || 'FY';
  const fyShort = getFyShortLabel(bundle.financial_year, yearType);
  await downloadWorkbook(wb, `FinCommandPro_AllReports_${fyShort}.xlsx`);
}
