'use client';

import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { ReportBundle } from '@/lib/dashboard/types';
import { getExportTables, type ExportTable } from './tables';
import { getFyLabel, getFyShortLabel, fl, unitSuffix, getUnitHeaderPdf, type DisplayUnit, type CurrencyCode } from '@/lib/utils/format';
import { getCurrencyMeta } from '@/lib/services/currency';
import { exportOverviewPdf } from './overview-pdf';
import { exportCashFlowPdf } from './cashflow-pdf';
import { exportMisPdf } from './mis-pdf';
import { exportBsPdf } from './bs-pdf';
import { exportPlPdf } from './pl-pdf';
import { exportNotesPdf } from './notes-pdf';
import { exportTreasuryPdf } from './treasury-pdf';

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

const REPORT_STANDARD = 'IND AS Schedule III Division II';
const DEFAULT_COMPANY_NAME = 'Sample Company (Demo Data)';

function addHeader(doc: jsPDF, title: string, subtitle: string, companyName: string) {
  // Top Header Banner Box
  doc.setFillColor(30, 58, 138); // Deep Navy Blue (#1e3a8a)
  doc.rect(0, 0, 210, 24, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(255, 255, 255);
  doc.text('FinCommand Pro', 14, 11);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(203, 213, 225); // Light slate
  doc.text(`${companyName}  |  ${REPORT_STANDARD}`, 14, 18);

  // Document Title & Subtitle Below Banner
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(15, 23, 42); // Dark slate
  doc.text(title, 14, 33);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text(subtitle, 14, 39);

  doc.setDrawColor(226, 232, 240);
  doc.line(14, 42, 196, 42);
}

function addFooter(doc: jsPDF) {
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(148, 163, 184);

    doc.setDrawColor(226, 232, 240);
    doc.line(14, doc.internal.pageSize.getHeight() - 12, 196, doc.internal.pageSize.getHeight() - 12);

    doc.text(
      `FinCommand Pro — Confidential Financial Report — Generated ${new Date().toLocaleDateString('en-IN')}`,
      14,
      doc.internal.pageSize.getHeight() - 6
    );

    doc.text(
      `Page ${i} of ${pageCount}`,
      196,
      doc.internal.pageSize.getHeight() - 6,
      { align: 'right' }
    );
  }
}

// jsPDF's base-14 fonts (Helvetica/Times/Courier under WinAnsiEncoding) have
// no glyph for ₹ or Arabic script (AED's د.إ) and — confirmed empirically —
// silently drop the *entire* string containing an unsupported character,
// not just the symbol. lib/exports/tables.ts (shared with the Excel
// exporter, which renders every symbol here correctly) is full of "(₹L)"-
// style column headers and "₹0.00"-style cell text — under a non-INR
// presentation currency, "(د.إ L)"/"د.إ 0.00" — so every PDF table built
// from it would otherwise render with blank headers and blank cells
// wherever one of these appears. Sanitize only at this PDF-rendering
// boundary — the shared data builder and the Excel path keep the real
// symbol. € and £ ARE in WinAnsiEncoding and need no substitution.
const sanitizePdfText = (s: string) => s.replace(/₹/g, 'Rs. ').replace(/د\.إ/g, 'AED ');

function renderTable(doc: jsPDF, table: ExportTable, startY: number): number {
  autoTable(doc, {
    startY,
    head: [table.columns.map(sanitizePdfText)],
    body: table.rows.map(r => r.map(v => (v != null ? sanitizePdfText(String(v)) : ''))),
    styles: {
      font: 'helvetica',
      fontSize: 8,
      cellPadding: 3,
      textColor: [30, 41, 59],
      lineColor: [226, 232, 240],
      lineWidth: 0.1,
    },
    headStyles: {
      fillColor: [30, 58, 138], // Deep Corporate Navy
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 8.5,
      halign: 'left',
    },
    alternateRowStyles: {
      fillColor: [248, 250, 252], // Soft slate tint
    },
    margin: { left: 14, right: 14 },
    columnStyles: {
      0: { fontStyle: 'normal' },
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (doc as any).lastAutoTable.finalY + 10;
}

/** Builds the document without triggering a browser download. */
export function buildSectionPdf(section: string, bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): { doc: jsPDF; fyShort: string } {
  const doc = new jsPDF();
  const tables = getExportTables(section, bundle, unit, compare, currency);
  const yearType = bundle.period_params?.yearType || 'FY';
  const fyLabel = getFyLabel(bundle.financial_year, yearType);
  const fyShort = getFyShortLabel(bundle.financial_year, yearType);
  const mainTitle = tables[0]?.title || `${section.toUpperCase()} Report`;

  addHeader(doc, mainTitle, `Reporting Period: ${bundle.period_label}  |  ${yearType}: ${fyLabel}`, companyName);

  let y = 46;
  tables.forEach((t, i) => {
    if (i > 0) {
      if (y > 250) {
        doc.addPage();
        addHeader(doc, mainTitle, `Reporting Period: ${bundle.period_label}  |  ${yearType}: ${fyLabel}`, companyName);
        y = 46;
      }
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(30, 58, 138);
      doc.text(t.title, 14, y);
      y += 6;
    }
    y = renderTable(doc, t, y);
  });

  addFooter(doc);
  return { doc, fyShort };
}

export function exportSectionPdf(section: string, bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): void {
  // Executive Overview, Cash Flow, MIS, and Balance Sheet get bespoke,
  // purpose-built layouts (KPI cards, native charts, color-coded tables)
  // instead of the generic key/value table dump every other section uses —
  // see overview-pdf.ts / cashflow-pdf.ts / mis-pdf.ts / bs-pdf.ts.
  if (section === 'overview') {
    exportOverviewPdf(bundle, companyName, unit, compare, currency);
    return;
  }
  if (section === 'cashflow') {
    exportCashFlowPdf(bundle, companyName, unit, compare, currency);
    return;
  }
  if (section === 'mis') {
    exportMisPdf(bundle, companyName, unit, compare, currency);
    return;
  }
  if (section === 'bs') {
    exportBsPdf(bundle, companyName, unit, compare, currency);
    return;
  }
  if (section === 'pl') {
    exportPlPdf(bundle, companyName, unit, compare, currency);
    return;
  }
  if (section === 'notes') {
    exportNotesPdf(bundle, companyName, unit, compare, currency);
    return;
  }
  if (section === 'treasury') {
    exportTreasuryPdf(bundle, companyName, unit, compare, currency);
    return;
  }
  const { doc, fyShort } = buildSectionPdf(section, bundle, companyName, unit, compare, currency);
  doc.save(`FinCommandPro_${section.toUpperCase()}_${fyShort}.pdf`);
}

export function exportAllPdf(bundle: ReportBundle, companyName = DEFAULT_COMPANY_NAME, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): void {
  const doc = new jsPDF();
  const yearType = bundle.period_params?.yearType || 'FY';
  const fyLabel = getFyLabel(bundle.financial_year, yearType);
  const fyShort = getFyShortLabel(bundle.financial_year, yearType);

  // ── Cover Page ─────────────────────────────────────────────────────────────
  // Deep Executive Navy Cover Card
  doc.setFillColor(30, 58, 138);
  doc.rect(0, 0, 210, 297, 'F');

  // Decorative Accent Line
  doc.setFillColor(245, 158, 11); // Gold accent (#f59e0b)
  doc.rect(20, 45, 8, 80, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(26);
  doc.setTextColor(255, 255, 255);
  doc.text('ANNUAL FINANCIAL REPORT', 36, 60);

  doc.setFontSize(14);
  doc.setTextColor(203, 213, 225);
  doc.text('& BOARD COMPLIANCE PACK', 36, 70);

  doc.setFontSize(10);
  doc.setTextColor(148, 163, 184);
  doc.text(`REPORTING PERIOD: ${fyLabel.toUpperCase()}`, 36, 85);
  doc.text(`IND AS SCHEDULE III DIVISION II COMPLIANT`, 36, 92);

  // White Card Overlay for Metadata
  doc.setFillColor(255, 255, 255);
  doc.roundedRect(20, 120, 170, 125, 4, 4, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(15, 23, 42);
  doc.text(companyName, 30, 138);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text(`Period: ${bundle.period_label}`, 30, 145);
  doc.text(`Reporting Currency: ${currency} (${getUnitHeaderPdf(unit, currency)})`, 30, 152);

  // Real balance-sheet-tally check, not a fixed claim — this cover page
  // used to always print "Verified & Balanced (₹0.00 Difference)"
  // regardless of the actual data, which is a false assurance on a
  // document meant for board/audit use if the Trial Balance genuinely
  // doesn't tally. Uses "Rs." not "₹" — jsPDF's base-14 fonts silently drop
  // any string containing ₹ entirely (confirmed empirically), which was
  // erasing this whole line, not just the symbol.
  const pdfSymbol = getCurrencyMeta(currency).pdfSymbol;
  if (bundle.bs.balanced) {
    doc.setTextColor(100, 116, 139);
    doc.text(`Audit Trail Status: Balance Sheet Tallies (${pdfSymbol} 0.00 Difference)`, 30, 159);
  } else {
    doc.setTextColor(185, 28, 28); // red — flag it, don't bury it
    doc.text(`Audit Trail Status: OUT OF BALANCE (${pdfSymbol} ${fl(bundle.bs.difference, 2, unit)}${unitSuffix(unit)} Difference) — review before circulating`, 30, 159);
  }

  // Table of Contents Box inside Card
  doc.setFillColor(248, 250, 252);
  doc.roundedRect(30, 175, 150, 58, 2, 2, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(30, 58, 138);
  doc.text('CONTENTS OF REPORT PACK:', 36, 185);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(71, 85, 105);
  doc.text('1. Executive MIS Report & P&L Rollup', 36, 194);
  doc.text('2. Balance Sheet (Equity, Liabilities & Assets)', 36, 201);
  doc.text('3. Statement of Profit & Loss (Schedule III)', 36, 208);
  doc.text('4. Notes to Accounts (Notes 1–26 Detailed Breakdown)', 36, 215);
  doc.text('5. Statement of Cash Flows (Indirect Method - IND AS 7)', 36, 222);
  doc.text('6. Treasury, Financial Ratios & Working Capital Analysis', 36, 229);

  // ── Pages for Each Section ────────────────────────────────────────────────
  ALL_SECTIONS.forEach(section => {
    const tables = getExportTables(section, bundle, unit, compare, currency);
    if (!tables.length) return;

    doc.addPage();
    const mainTitle = tables[0].title;
    addHeader(doc, mainTitle, `Period: ${bundle.period_label}  |  Financial Year: ${bundle.financial_year.label}`, companyName);

    let y = 46;
    tables.forEach((t, i) => {
      if (i > 0) {
        if (y > 240) {
          doc.addPage();
          addHeader(doc, mainTitle, `Period: ${bundle.period_label}  |  Financial Year: ${bundle.financial_year.label}`, companyName);
          y = 46;
        }
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.setTextColor(30, 58, 138);
        doc.text(t.title, 14, y);
        y += 6;
      }
      y = renderTable(doc, t, y);
    });
  });

  addFooter(doc);
  doc.save(`FinCommandPro_AnnualReport_${fyShort}.pdf`);
}
