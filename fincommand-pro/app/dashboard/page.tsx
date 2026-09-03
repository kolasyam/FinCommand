'use client';

import { useEffect, useState } from 'react';
import { DashboardProvider, useDashboard } from '@/lib/dashboard/DashboardContext';
import { ToastProvider } from '@/lib/dashboard/ToastContext';
import { TopBar } from '@/components/dashboard/TopBar';
import { PeriodBar } from '@/components/dashboard/PeriodBar';
import { NavTabs } from '@/components/dashboard/NavTabs';
import { LoginModal } from '@/components/dashboard/LoginModal';
import { AddFyModal } from '@/components/dashboard/AddFyModal';
import { LoadingBar, ErrorBanner } from '@/components/ui/StatusBanners';
import { OverviewTab } from '@/components/dashboard/tabs/OverviewTab';
import { CashFlowTab } from '@/components/dashboard/tabs/CashFlowTab';
import { MisTab } from '@/components/dashboard/tabs/MisTab';
import { BalanceSheetTab } from '@/components/dashboard/tabs/BalanceSheetTab';
import { PLTab } from '@/components/dashboard/tabs/PLTab';
import { NotesTab } from '@/components/dashboard/tabs/NotesTab';
import { TreasuryTab } from '@/components/dashboard/tabs/TreasuryTab';
import { RatiosTab } from '@/components/dashboard/tabs/RatiosTab';
import { ScenarioTab } from '@/components/dashboard/tabs/ScenarioTab';
import { WorkingCapitalTab } from '@/components/dashboard/tabs/WorkingCapitalTab';
import { AlertsTab } from '@/components/dashboard/tabs/AlertsTab';
import { ComplianceTab } from '@/components/dashboard/tabs/ComplianceTab';
import { BoardPackTab } from '@/components/dashboard/tabs/BoardPackTab';
import { UploadTab } from '@/components/dashboard/tabs/UploadTab';
import { exportAllPdf } from '@/lib/exports/pdf';
import { exportAllXlsx } from '@/lib/exports/xlsx';
import { useToast } from '@/lib/dashboard/ToastContext';

function EmptyStateCard({
  title = 'Please upload Trial Balance data to unlock features',
  subtitle,
  onNavigateUpload,
  onOpenAddFy,
  onExploreSample,
}: {
  title?: string;
  subtitle: string;
  onNavigateUpload: () => void;
  onOpenAddFy: () => void;
  onExploreSample?: () => void;
}) {
  return (
    <div
      style={{
        maxWidth: 600,
        margin: '40px auto',
        padding: '36px 32px',
        textAlign: 'center',
        background: 'var(--bg-card, #ffffff)',
        border: '1px solid var(--border, #e2e8f0)',
        borderRadius: 12,
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.05)',
      }}
    >
      <div style={{ fontSize: 44, marginBottom: 16 }}>📊</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', marginBottom: 10, lineHeight: 1.3 }}>
        {title}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 24, lineHeight: 1.6 }}>
        {subtitle}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 10,
          marginBottom: 28,
          textAlign: 'left',
          background: 'var(--bg2, #f8fafc)',
          padding: 14,
          borderRadius: 8,
          border: '1px solid var(--border2, #e2e8f0)',
          fontSize: 12,
          color: 'var(--text2)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: '#2563eb', fontWeight: 'bold' }}>✓</span> Balance Sheet &amp; P&amp;L (Schedule III)
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: '#2563eb', fontWeight: 'bold' }}>✓</span> Cash Flows (IND AS 7)
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: '#2563eb', fontWeight: 'bold' }}>✓</span> Notes to Accounts (1–26)
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: '#2563eb', fontWeight: 'bold' }}>✓</span> MIS &amp; Ratio Analysis
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
        <button
          className="btn btn-pr"
          onClick={onNavigateUpload}
          style={{ padding: '9px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
        >
          ⬆ Upload Trial Balance
        </button>
        <button
          className="btn btn-se"
          onClick={onOpenAddFy}
          style={{ padding: '9px 18px', fontSize: 13, cursor: 'pointer' }}
        >
          ➕ Add Financial Year
        </button>
        {onExploreSample && (
          <button
            className="btn btn-se"
            onClick={onExploreSample}
            style={{ padding: '9px 18px', fontSize: 13, cursor: 'pointer', borderColor: '#3b82f6', color: '#2563eb' }}
          >
            ⚡ Try Sample Demo
          </button>
        )}
      </div>
    </div>
  );
}

function DashboardShell() {
  const { bundle, granularity, loading, error, refresh, dataMode, fyList, currentFyId, useSampleData, booting, user, requestedTab, clearRequestedTab, displayUnit, presentationCurrency } = useDashboard();
  const [activeTab, setActiveTab] = useState('overview');
  const [loginOpen, setLoginOpen] = useState(false);
  const [addFyOpen, setAddFyOpen] = useState(false);
  const toast = useToast();

  // A Note reference clicked on Balance Sheet / P&L (or anywhere else in the
  // future) requests a tab switch via DashboardContext — this is the one
  // place that owns `activeTab`, so it's the one place that acts on the
  // request. NotesTab separately watches `pendingNoteKey` to scroll to and
  // highlight the specific note once it has mounted.
  useEffect(() => {
    if (requestedTab) {
      setActiveTab(requestedTab);
      clearRequestedTab();
    }
  }, [requestedTab, clearRequestedTab]);

  const companyName = dataMode === 'api' && user?.company_name ? user.company_name : undefined;

  function downloadAllXlsx() {
    if (!bundle) { toast('Load report data first (switch out of 3-Year view)'); return; }
    // "Download All" has no single tab's Compare toggle to respect, so it
    // defaults to including YoY comparison wherever prior-year data exists —
    // the same behavior this bundle always had.
    exportAllXlsx(bundle, companyName, displayUnit, true, presentationCurrency);
    toast('All reports exported to Excel');
  }
  function downloadAllPdf() {
    if (!bundle) { toast('Load report data first (switch out of 3-Year view)'); return; }
    exportAllPdf(bundle, companyName, displayUnit, true, presentationCurrency);
    toast('Annual Report PDF downloaded');
  }

  function renderTab() {
    if (activeTab === 'upload') return <UploadTab onOpenLogin={() => setLoginOpen(true)} onNavigate={setActiveTab} onOpenAddFy={() => setAddFyOpen(true)} />;

    // Logged-in but no fiscal years created yet or no FY selected
    if (dataMode === 'api' && (fyList.length === 0 || !currentFyId) && !loading && !booting) {
      return (
        <EmptyStateCard
          title="Please upload Trial Balance data to unlock features"
          subtitle="Welcome to FinCommand Pro! Your account currently has no financial data uploaded. To generate live financial statements (Balance Sheet, Profit & Loss, Statement of Cash Flows, Notes to Accounts, MIS Reports, and Financial Ratios), please create a financial year and upload your Trial Balance file."
          onNavigateUpload={() => setActiveTab('upload')}
          onOpenAddFy={() => setAddFyOpen(true)}
          onExploreSample={useSampleData}
        />
      );
    }

    const noData = granularity !== '3year' && !bundle && !loading && !booting;
    if (noData && dataMode === 'api') {
      return (
        <EmptyStateCard
          title="Please upload Trial Balance data to unlock features"
          subtitle="No Trial Balance data has been uploaded for this financial year yet. Upload your Trial Balance Excel or CSV file to unlock financial statements and analytics."
          onNavigateUpload={() => setActiveTab('upload')}
          onOpenAddFy={() => setAddFyOpen(true)}
          onExploreSample={useSampleData}
        />
      );
    }

    switch (activeTab) {
      case 'overview': return <OverviewTab />;
      case 'cashflow': return <CashFlowTab />;
      case 'mis': return <MisTab />;
      case 'bs': return <BalanceSheetTab />;
      case 'pl': return <PLTab />;
      case 'notes': return <NotesTab />;
      case 'funds': return <TreasuryTab />;
      case 'ratios': return <RatiosTab />;
      case 'scenario': return <ScenarioTab />;
      case 'wc': return <WorkingCapitalTab />;
      case 'alerts': return <AlertsTab />;
      case 'compliance': return <ComplianceTab />;
      case 'boardpack': return <BoardPackTab />;
      default: return null;
    }
  }

  return (
    <div>
      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />
      <AddFyModal open={addFyOpen} onClose={() => setAddFyOpen(false)} />
      <TopBar
        onNavigate={setActiveTab}
        onOpenLogin={() => setLoginOpen(true)}
        onDownloadAllXlsx={downloadAllXlsx}
        onDownloadAllPdf={downloadAllPdf}
        onOpenAddFy={() => setAddFyOpen(true)}
      />
      <PeriodBar />
      <NavTabs active={activeTab} onChange={setActiveTab} />
      <div className="content">
        {(booting || loading) && (
          <LoadingBar label={user?.company_name ? `Loading financial reports for ${user.company_name}…` : 'Loading dashboard session…'} />
        )}
        {error && !loading && !booting && <ErrorBanner message={error} onRetry={refresh} />}
        {!loading && !booting && renderTab()}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <ToastProvider>
      <DashboardProvider>
        <DashboardShell />
      </DashboardProvider>
    </ToastProvider>
  );
}
