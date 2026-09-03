'use client';

/**
 * Shared primitives for the bespoke, per-tab PDF exports (overview-pdf.ts,
 * cashflow-pdf.ts, and future tab-specific exports) — colors, page header/
 * footer, KPI cards, and small layout helpers. Kept separate from the
 * generic per-section table exporter in pdf.ts, which every tab without a
 * bespoke layout still falls back to.
 */
import { jsPDF } from 'jspdf';

export const NAVY: [number, number, number] = [30, 58, 138];
export const NAVY_DARK: [number, number, number] = [15, 23, 42];
export const SLATE: [number, number, number] = [100, 116, 139];
export const SLATE_LIGHT: [number, number, number] = [203, 213, 225];
export const BORDER: [number, number, number] = [226, 232, 240];
export const GREEN: [number, number, number] = [15, 110, 86];
export const GREEN_TINT: [number, number, number] = [225, 245, 238];
export const RED: [number, number, number] = [153, 60, 29];
export const RED_TINT: [number, number, number] = [250, 236, 231];
export const BLUE_TINT: [number, number, number] = [239, 246, 255];
export const AMBER: [number, number, number] = [180, 130, 20];
export const AMBER_TINT: [number, number, number] = [254, 249, 231];

export const PAGE_W = 210;
export const MARGIN = 14;
export const CONTENT_W = PAGE_W - MARGIN * 2;

export const DEFAULT_COMPANY_NAME = 'Sample Company (Demo Data)';

export function toneColor(v: number): [number, number, number] {
  if (Math.abs(v) < 0.005) return NAVY_DARK;
  return v < 0 ? RED : GREEN;
}
export function toneTint(v: number): [number, number, number] {
  if (Math.abs(v) < 0.005) return BLUE_TINT;
  return v < 0 ? RED_TINT : GREEN_TINT;
}

/** Page header banner — `subtitle` names the specific statement (e.g. "Statement of Cash Flows · CFO Financial Command Center"). */
export function addPdfHeader(doc: jsPDF, companyName: string, subtitle: string, fyLabel: string, periodLabel: string) {
  doc.setFillColor(...NAVY);
  doc.rect(0, 0, PAGE_W, 26, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(255, 255, 255);
  doc.text('FinCommand Pro', MARGIN, 11);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...SLATE_LIGHT);
  doc.text(subtitle, MARGIN, 17.5);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(255, 255, 255);
  doc.text(companyName, PAGE_W - MARGIN, 11, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...SLATE_LIGHT);
  doc.text(`${fyLabel} · ${periodLabel}`, PAGE_W - MARGIN, 17.5, { align: 'right' });
}

export function addPdfFooter(doc: jsPDF) {
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    const h = doc.internal.pageSize.getHeight();
    doc.setDrawColor(...BORDER);
    doc.line(MARGIN, h - 12, PAGE_W - MARGIN, h - 12);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...SLATE);
    doc.text(`FinCommand Pro — Confidential — Generated ${new Date().toLocaleDateString('en-IN')}`, MARGIN, h - 6);
    doc.text(`Page ${i} of ${pageCount}`, PAGE_W - MARGIN, h - 6, { align: 'right' });
  }
}

export interface KpiCardSpec {
  label: string;
  value: string;
  sub: string;
  tone: number; // sign drives accent color; magnitude irrelevant
}

export function drawKpiCards(doc: jsPDF, cards: KpiCardSpec[], y: number): number {
  const gap = 4;
  const w = (CONTENT_W - gap * (cards.length - 1)) / cards.length;
  const h = 27;

  cards.forEach((c, i) => {
    const x = MARGIN + i * (w + gap);
    const color = toneColor(c.tone);
    const tint = toneTint(c.tone);

    doc.setFillColor(...tint);
    doc.roundedRect(x, y, w, h, 2, 2, 'F');
    doc.setFillColor(...color);
    doc.roundedRect(x, y, 2, h, 1, 1, 'F');

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...SLATE);
    doc.text(c.label.toUpperCase(), x + 5, y + 7);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13.5);
    doc.setTextColor(...color);
    doc.text(c.value, x + 5, y + 16);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...SLATE);
    doc.text(c.sub, x + 5, y + 22.5);
  });

  return y + h;
}

export function pdfSectionTitle(doc: jsPDF, title: string, y: number, badge?: string): number {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...NAVY);
  doc.text(title, MARGIN, y);
  if (badge) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...SLATE);
    doc.text(badge, PAGE_W - MARGIN, y, { align: 'right' });
  }
  return y + 5;
}

export function pdfTableBottom(doc: jsPDF): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (doc as any).lastAutoTable.finalY;
}

/** Standard autoTable style/headStyles pair used by every bespoke PDF table — keeps them visually identical across tabs. */
export const PDF_TABLE_STYLES = {
  styles: { font: 'helvetica' as const, fontSize: 8, cellPadding: 2.6, textColor: NAVY_DARK, lineColor: BORDER, lineWidth: 0.1 },
  headStyles: { fillColor: NAVY, textColor: [255, 255, 255] as [number, number, number], fontStyle: 'bold' as const, fontSize: 8, halign: 'left' as const },
  margin: { left: MARGIN, right: MARGIN },
};
