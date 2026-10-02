'use client';

/** Thin apiFetch() wrappers for the Report Builder module's own endpoints — kept separate from the main dashboard bundle (lib/dashboard/api-client.ts's apiFetch) since templates/saved reports are company-wide, not tied to the global PeriodBar's FY+period selection, same reasoning UploadTab's own direct apiFetch calls already follow for Zoho-specific state. */

import { apiFetch } from './api-client';
import type {
  ReportTemplate, ReportLine, LineLedgerMap, LineType, ValidationResult, ReportRow, FormatPreset,
} from '@/lib/financial/report-builder-engine';

export interface TemplateSummary extends ReportTemplate {
  lineCount: number;
  detailCount: number;
  errorCount: number;
  warningCount: number;
}

export function fetchTemplates() {
  return apiFetch<{ templates: TemplateSummary[]; presets: FormatPreset[] }>('/report-builder/templates');
}

export function createBlankTemplate(name: string) {
  return apiFetch<{ template: ReportTemplate }>('/report-builder/templates', {
    method: 'POST', body: JSON.stringify({ name }),
  });
}

export function cloneTemplate(name: string, cloneFromTemplateId: string) {
  return apiFetch<{ template: ReportTemplate }>('/report-builder/templates', {
    method: 'POST', body: JSON.stringify({ name, cloneFromTemplateId }),
  });
}

export function createFromPreset(name: string, presetId: string, financialYearId: string) {
  return apiFetch<{ template: ReportTemplate }>('/report-builder/templates', {
    method: 'POST', body: JSON.stringify({ name, presetId, financialYearId }),
  });
}

export function fetchTemplateStructure(templateId: string) {
  return apiFetch<{ template: ReportTemplate; lines: ReportLine[]; lineLedgerMap: LineLedgerMap }>(
    `/report-builder/templates/${templateId}`
  );
}

export function renameTemplate(templateId: string, name: string) {
  return apiFetch(`/report-builder/templates/${templateId}`, { method: 'PUT', body: JSON.stringify({ name }) });
}

export function deleteTemplate(templateId: string) {
  return apiFetch(`/report-builder/templates/${templateId}`, { method: 'DELETE' });
}

export interface StructureLinePayload {
  id: string; parentLineId: string | null; label: string; sequence: number;
  lineType: LineType; sign: 1 | -1; isPercentBase: boolean; resetsAfter: boolean;
}

export function saveStructure(templateId: string, lines: StructureLinePayload[], financialYearId?: string) {
  return apiFetch<{ message: string; validation: ValidationResult }>(
    `/report-builder/templates/${templateId}/structure`,
    { method: 'PUT', body: JSON.stringify({ lines, financialYearId }) }
  );
}

export function setLineLedgers(lineId: string, ledgerNames: string[]) {
  return apiFetch(`/report-builder/lines/${lineId}/ledgers`, {
    method: 'PUT', body: JSON.stringify({ ledgerNames }),
  });
}

export interface RealLedgerOption { name: string; section: string | null; noteName: string | null }

export function fetchLedgerOptions(fyId: string) {
  return apiFetch<{ ledgers: RealLedgerOption[] }>(`/report-builder/ledgers?fy_id=${fyId}`);
}

export function runReport(templateId: string, financialYearId: string, monthIndices: number[]) {
  return apiFetch<{ financial_year: unknown; month_indices: number[]; rows: ReportRow[]; generated_at: string }>(
    `/report-builder/templates/${templateId}/run`,
    { method: 'POST', body: JSON.stringify({ financialYearId, monthIndices }) }
  );
}

export interface SavedReportDTO {
  id: string; company_id: string; template_id: string; financial_year_id: string;
  name: string; month_indices: number[]; show_percent: boolean;
  created_by: string | null; created_at: string; updated_at: string; last_run_at: string | null;
}

export function fetchSavedReports() {
  return apiFetch<{ reports: SavedReportDTO[] }>('/report-builder/saved-reports');
}

export function createSavedReport(input: {
  name: string; templateId: string; financialYearId: string; monthIndices: number[]; showPercent: boolean;
}) {
  return apiFetch<{ report: SavedReportDTO }>('/report-builder/saved-reports', {
    method: 'POST', body: JSON.stringify(input),
  });
}

export function updateSavedReport(id: string, patch: Partial<{
  name: string; monthIndices: number[]; showPercent: boolean; financialYearId: string;
}>) {
  return apiFetch(`/report-builder/saved-reports/${id}`, { method: 'PUT', body: JSON.stringify(patch) });
}

export function deleteSavedReport(id: string) {
  return apiFetch(`/report-builder/saved-reports/${id}`, { method: 'DELETE' });
}
