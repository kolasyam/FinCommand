'use client';

/**
 * A user-created custom dashboard tab — the same trivial case of
 * CustomizableTabPanel that MyDashboardTab.tsx is (no prior fixed view to
 * protect, defaultWidgets=[] since there's no universal starter KPI set for
 * a tab whose whole purpose is user-defined), except `tabKey` is a prop
 * here instead of a literal, since it's one of potentially many custom tabs
 * rather than the single fixed 'my-dashboard'.
 */
import { useCustomTabs } from '@/lib/dashboard/CustomTabsContext';
import { CustomizableTabPanel } from './dashboard-builder/CustomizableTabPanel';

export function CustomTab({ tabKey }: { tabKey: string }) {
  const { tabs, loaded } = useCustomTabs();
  const tab = tabs.find((t) => t.tabKey === tabKey);

  // The tab list has loaded and this tabKey isn't in it — it was deleted
  // (by someone else, or in another browser tab) while this one was open.
  // A distinct message, not TabCustomizationsContext's usual silent-fail-
  // toward-empty: that convention is correct for a NETWORK failure, wrong
  // for "this entity no longer exists" — the difference matters here
  // because CustomizableTabPanel would otherwise just show an empty grid
  // with no explanation of why nothing can be saved to it anymore.
  if (loaded && !tab) {
    return (
      <div className="notice" style={{ padding: 30, textAlign: 'center' }}>
        This custom tab was removed. Pick another tab from the sidebar.
      </div>
    );
  }

  return (
    <CustomizableTabPanel
      tabKey={tabKey}
      defaultWidgets={[]}
      fixedView={null}
      title={tab ? `${tab.icon ?? '📌'} ${tab.name}` : 'Custom Tab'}
    />
  );
}
