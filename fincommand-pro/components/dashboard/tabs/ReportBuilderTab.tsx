'use client';

import { useState } from 'react';
import { useDashboard } from '@/lib/dashboard/DashboardContext';
import { TemplateList } from './report-builder/TemplateList';
import { StructureEditor } from './report-builder/StructureEditor';
import { LedgerMapper } from './report-builder/LedgerMapper';
import { ReportViewer } from './report-builder/ReportViewer';
import { MyReports } from './report-builder/MyReports';
import type { SavedReportDTO } from '@/lib/dashboard/report-builder-api';

type Tab = 'formats' | 'reports';
type View =
  | { screen: 'home'; tab: Tab }
  | { screen: 'structure' | 'map'; templateId: string }
  | { screen: 'run'; templateId: string; savedReport?: SavedReportDTO | null };

/**
 * Report Builder — custom statement formats (Format Builder + Report
 * Viewer). Ported from a Lovable-built reference prototype a manager sent
 * for this exact module (see lib/financial/report-builder-engine.ts's
 * header comment for what was corrected on port, not carried over
 * verbatim). Fully additive: real Zoho-synced ledgers via
 * /api/v1/report-builder/*, zero changes to the existing Trial Balance
 * upload, Note assignment, or any other report tab.
 *
 * Dashboard Builder (charts/KPI tiles from the reference) and comparison/
 * variance/YTD report columns were both explicitly deferred to a later
 * pass — this ships Format Builder + Report Viewer with plain period
 * selection, verified against real data first.
 */
export function ReportBuilderTab() {
  const { dataMode, fyList, currentFyId } = useDashboard();
  const [view, setView] = useState<View>({ screen: 'home', tab: 'formats' });

  if (dataMode !== 'api') {
    return (
      <div className="notice" style={{ padding: 30, textAlign: 'center' }}>
        Report Builder needs a real signed-in company — you&apos;re viewing sample data. Sign in and connect Zoho Books or
        upload a Trial Balance to build custom report formats against your real ledgers.
      </div>
    );
  }

  if (fyList.length === 0) {
    return (
      <div className="notice" style={{ padding: 30, textAlign: 'center' }}>
        Create a financial year and sync/upload a Trial Balance first (Upload tab) — Report Builder maps its lines against
        real ledgers from your data.
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <div style={{ fontSize: 18, fontWeight: 700 }}>Report Builder</div>
        <span className="pill pb">Custom formats</span>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 16 }}>
        Build reusable statement formats — nested lines, subtotals, signs, per-format ledger mapping — then run them
        against any period and save the configuration for later.
      </p>

      {view.screen === 'home' && (
        <>
          <div className="ntabs" style={{ marginBottom: 20 }}>
            <button
              className={`ntab${view.tab === 'formats' ? ' active' : ''}`}
              onClick={() => setView({ screen: 'home', tab: 'formats' })}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: view.tab === 'formats' ? 1 : 0.7 }}>
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M3 9h18" />
                <path d="M9 21V9" />
              </svg>
              Formats
            </button>
            <button
              className={`ntab${view.tab === 'reports' ? ' active' : ''}`}
              onClick={() => setView({ screen: 'home', tab: 'reports' })}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: view.tab === 'reports' ? 1 : 0.7 }}>
                <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                <polyline points="14 2 14 8 20 8" />
                <path d="M16 13H8" />
                <path d="M16 17H8" />
                <path d="M10 9H8" />
              </svg>
              My Reports
            </button>
          </div>
          {view.tab === 'formats' && (
            <TemplateList
              fyList={fyList}
              currentFyId={currentFyId}
              onOpen={(templateId) => setView({ screen: 'structure', templateId })}
              onRun={(templateId) => setView({ screen: 'run', templateId })}
            />
          )}
          {view.tab === 'reports' && (
            <MyReports fyList={fyList} onOpen={(report) => setView({ screen: 'run', templateId: report.template_id, savedReport: report })} />
          )}
        </>
      )}

      {view.screen === 'structure' && (
        <StructureEditor
          templateId={view.templateId}
          currentFyId={currentFyId}
          onBack={() => setView({ screen: 'home', tab: 'formats' })}
          onMapLedgers={() => setView({ screen: 'map', templateId: view.templateId })}
        />
      )}

      {view.screen === 'map' && (
        <LedgerMapper
          templateId={view.templateId}
          currentFyId={currentFyId}
          onBack={() => setView({ screen: 'structure', templateId: view.templateId })}
        />
      )}

      {view.screen === 'run' && (
        <ReportViewer
          templateId={view.templateId}
          fyList={fyList}
          defaultFyId={currentFyId}
          savedReport={view.savedReport}
          onBack={() => setView({ screen: 'home', tab: view.savedReport ? 'reports' : 'formats' })}
          onSaved={(report) => setView({ screen: 'run', templateId: view.templateId, savedReport: report })}
        />
      )}
    </div>
  );
}
