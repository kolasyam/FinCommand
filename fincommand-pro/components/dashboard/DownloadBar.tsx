'use client';

import { useDashboard } from '@/lib/dashboard/DashboardContext';
import { useToast } from '@/lib/dashboard/ToastContext';
import { exportSectionPdf } from '@/lib/exports/pdf';
import { exportSectionXlsx } from '@/lib/exports/xlsx';

export function DownloadBar({ title, subtitle, section, compareEnabled = true }: { title: string; subtitle: string; section: string; compareEnabled?: boolean }) {
  const { bundle, dataMode, user, displayUnit, presentationCurrency } = useDashboard();
  const toast = useToast();
  // Only a real logged-in company's own name is ever used on an export —
  // sample mode (or a bundle with no session, defensively) falls back to an
  // explicit "demo data" label rather than any specific company name.
  const companyName = dataMode === 'api' && user?.company_name ? user.company_name : undefined;

  function downloadPdf() {
    if (!bundle) return;
    exportSectionPdf(section, bundle, companyName, displayUnit, compareEnabled, presentationCurrency);
    toast('PDF downloaded');
  }
  function downloadXlsx() {
    if (!bundle) return;
    exportSectionXlsx(section, bundle, companyName, displayUnit, compareEnabled, presentationCurrency);
    toast('Excel downloaded');
  }

  return (
    <div className="dl-bar">
      <div>
        <div className="dl-bar-title">{title}</div>
        <div className="dl-bar-sub">{subtitle}</div>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn btn-dl pdf" onClick={downloadPdf} disabled={!bundle}>⬇ PDF</button>
        <button className="btn btn-dl xlsx" onClick={downloadXlsx} disabled={!bundle}>⬇ Excel</button>
      </div>
    </div>
  );
}
