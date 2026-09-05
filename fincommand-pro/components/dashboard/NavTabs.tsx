'use client';

export const TABS: { id: string; label: string; badge?: string }[] = [
  { id: 'overview', label: 'Executive Overview' },
  { id: 'cashflow', label: 'Cash Flow', badge: 'IND AS 7' },
  { id: 'mis', label: 'MIS Report' },
  { id: 'bs', label: 'Balance Sheet' },
  { id: 'pl', label: 'P&L Account' },
  { id: 'notes', label: 'Notes to Accounts' },
  { id: 'funds', label: 'Treasury' },
  { id: 'ratios', label: 'Ratio Analysis' },
  { id: 'scenario', label: 'Scenario Planner' },
  { id: 'wc', label: 'Working Capital' },
  { id: 'customer-margin', label: 'Customer Margin', badge: 'Zoho' },
  { id: 'vendor-expense', label: 'Vendor Expense', badge: 'Zoho' },
  { id: 'alerts', label: 'Smart Alerts' },
  { id: 'compliance', label: 'Compliance' },
  { id: 'boardpack', label: 'Board Pack' },
  { id: 'upload', label: 'Upload / Architecture' },
];

export function NavTabs({ active, onChange }: { active: string; onChange: (id: string) => void }) {
  return (
    <div className="ntabs">
      {TABS.map(t => (
        <button key={t.id} className={`ntab${active === t.id ? ' active' : ''}`} onClick={() => onChange(t.id)}>
          {t.label}
          {t.badge && <span className="new-badge">{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}
