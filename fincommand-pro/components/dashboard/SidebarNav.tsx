'use client';

import { useDashboard } from '@/lib/dashboard/DashboardContext';
import { useCustomTabs } from '@/lib/dashboard/CustomTabsContext';

interface NavItem { id: string; label: string; icon: string; badge?: string }
interface NavGroup { label: string; icon: string; items: NavItem[] }

// Mirrors ROLE_SETS.isCFO in lib/auth/permissions.ts (server-only, same
// precedent as CustomizableTabPanel.tsx's own CAN_SET_COMPANY_DEFAULT_ROLES)
// — only gates whether the "+ New" affordance is shown; the API route
// re-checks this itself regardless.
const CAN_CREATE_CUSTOM_TABS_ROLES = ['admin', 'cfo'];
// Mirrors ROLE_SETS.canWrite (custom metrics use a wider role set than
// custom tabs — see app/api/v1/custom-metrics/route.ts) — deliberately a
// separate const from CAN_CREATE_CUSTOM_TABS_ROLES above, not a shared one.
const CAN_MANAGE_CUSTOM_METRICS_ROLES = ['admin', 'cfo', 'manager'];

/**
 * Same 17 tab ids as the old flat NavTabs.tsx (superseded by this
 * component) — grouped into 5 executive sections instead of one long
 * horizontally-scrolling row. Grouping is presentation only: every id here
 * must still match a `case` in app/dashboard/page.tsx's renderTab() switch.
 */
const GROUPS: NavGroup[] = [
  {
    label: 'Financial Statements', icon: '📊',
    items: [
      { id: 'overview', label: 'Executive Overview', icon: '🏠' },
      { id: 'bs', label: 'Balance Sheet', icon: '⚖️' },
      { id: 'pl', label: 'P&L Account', icon: '💰' },
      { id: 'cashflow', label: 'Cash Flow', icon: '💧', badge: 'IND AS 7' },
      { id: 'notes', label: 'Notes to Accounts', icon: '📝' },
    ],
  },
  {
    label: 'Analytics & Performance', icon: '📈',
    items: [
      { id: 'mis', label: 'MIS Report', icon: '📋' },
      { id: 'ratios', label: 'Ratio Analysis', icon: '🎯' },
      { id: 'wc', label: 'Working Capital', icon: '🔄' },
      { id: 'funds', label: 'Treasury', icon: '🏦' },
    ],
  },
  {
    label: 'Counterparty Intelligence', icon: '🤝',
    items: [
      { id: 'customer-margin', label: 'Customer Margin', icon: '👥', badge: 'Zoho' },
      { id: 'vendor-expense', label: 'Vendor Expense', icon: '🏭', badge: 'Zoho' },
    ],
  },
  {
    label: 'Governance & Planning', icon: '🛡️',
    items: [
      { id: 'scenario', label: 'Scenario Planner', icon: '🔮' },
      { id: 'alerts', label: 'Smart Alerts', icon: '🔔' },
      { id: 'compliance', label: 'Compliance', icon: '✅' },
    ],
  },
  {
    label: 'Data & Tools', icon: '🛠️',
    items: [
      { id: 'boardpack', label: 'Board Pack', icon: '📑' },
      { id: 'report-builder', label: 'Report Builder', icon: '🧩', badge: 'New' },
      { id: 'upload', label: 'Upload / Architecture', icon: '⬆️' },
    ],
  },
];

export function SidebarNav({
  active, onChange, mobileOpen, onCloseMobile, onManageCustomTabs, onManageCustomMetrics,
}: {
  active: string;
  onChange: (id: string) => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onManageCustomTabs: () => void;
  onManageCustomMetrics: () => void;
}) {
  const { user, dataMode } = useDashboard();
  const { tabs: customTabs } = useCustomTabs();
  const canCreateCustomTabs = !!user && CAN_CREATE_CUSTOM_TABS_ROLES.includes(user.role);
  const canManageCustomMetrics = !!user && CAN_MANAGE_CUSTOM_METRICS_ROLES.includes(user.role);

  function select(id: string) {
    onChange(id);
    onCloseMobile();
  }

  function openManageCustomTabs() {
    onManageCustomTabs();
    onCloseMobile();
  }

  function openManageCustomMetrics() {
    onManageCustomMetrics();
    onCloseMobile();
  }

  return (
    <>
      {mobileOpen && <div className="sidebar-backdrop" onClick={onCloseMobile} aria-hidden="true" />}
      <aside className={`sidebar${mobileOpen ? ' open' : ''}`} aria-label="Dashboard navigation">
        <nav className="sidebar-nav">
          {GROUPS.map((group) => (
            <div key={group.label} className="sidebar-group">
              <div className="sidebar-group-label">
                <span>{group.icon}</span>
                <span>{group.label}</span>
              </div>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`sidebar-item${active === item.id ? ' active' : ''}`}
                  onClick={() => select(item.id)}
                  aria-current={active === item.id ? 'page' : undefined}
                >
                  <span className="sidebar-item-icon" aria-hidden="true">{item.icon}</span>
                  <span className="sidebar-item-label">{item.label}</span>
                  {item.badge && <span className="sidebar-item-badge">{item.badge}</span>}
                </button>
              ))}
            </div>
          ))}

          {/* Custom tabs — a company's own user-created dashboards (see
              docs/ledgerframe-integration-blueprint.md for the gap this
              closes). This block is always rendered, even at zero custom
              tabs, so the very first one a company creates isn't a
              chicken-and-egg discovery problem. */}
          <div className="sidebar-group">
            <div className="sidebar-group-label">
              <span>🧩</span>
              <span>Custom Tabs</span>
            </div>
            {customTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`sidebar-item${active === tab.tabKey ? ' active' : ''}`}
                onClick={() => select(tab.tabKey)}
                aria-current={active === tab.tabKey ? 'page' : undefined}
              >
                <span className="sidebar-item-icon" aria-hidden="true">{tab.icon || '📌'}</span>
                <span className="sidebar-item-label">{tab.name}</span>
              </button>
            ))}
            <button type="button" className="sidebar-item" onClick={openManageCustomTabs}>
              <span className="sidebar-item-icon" aria-hidden="true">⚙</span>
              <span className="sidebar-item-label">{canCreateCustomTabs ? 'Manage custom tabs' : 'View custom tabs'}</span>
            </button>
          </div>

          {/* Custom metrics — company-authored formulas composed from the
              built-in catalog (see CustomMetricBuilder.tsx). Always
              rendered, same "no chicken-and-egg discovery problem" reasoning
              as the Custom Tabs group above. */}
          <div className="sidebar-group">
            <div className="sidebar-group-label">
              <span>📐</span>
              <span>Custom Metrics</span>
            </div>
            <button type="button" className="sidebar-item" onClick={openManageCustomMetrics}>
              <span className="sidebar-item-icon" aria-hidden="true">⚙</span>
              <span className="sidebar-item-label">{canManageCustomMetrics ? 'Manage custom metrics' : 'View custom metrics'}</span>
            </button>
          </div>
        </nav>

        {user && (
          <div className="sidebar-footer">
            <div className="sidebar-footer-avatar">{user.name.charAt(0).toUpperCase()}</div>
            <div style={{ minWidth: 0 }}>
              <div className="sidebar-footer-name">{user.name}</div>
              <div className="sidebar-footer-role">{user.role.toUpperCase()} · {user.company_name}</div>
            </div>
          </div>
        )}
        {!user && (
          <div className="sidebar-footer">
            <div className="sidebar-footer-avatar">?</div>
            <div style={{ minWidth: 0 }}>
              <div className="sidebar-footer-name">{dataMode === 'api' ? 'Loading…' : 'Sample Data'}</div>
              <div className="sidebar-footer-role">Not signed in</div>
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
