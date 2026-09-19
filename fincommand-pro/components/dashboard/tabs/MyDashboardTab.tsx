'use client';

/**
 * "My Dashboard" — each user's own customizable KPI layout. The trivial case
 * of the generalized CustomizableTabPanel (see
 * components/dashboard/tabs/dashboard-builder/CustomizableTabPanel.tsx): no
 * prior fixed view to protect, so it always renders the widget grid, seeded
 * from SYSTEM_DEFAULT_WIDGETS the first time nothing's been saved yet.
 */
import { SYSTEM_DEFAULT_WIDGETS } from '@/lib/dashboard-builder/default-layout';
import { CustomizableTabPanel } from './dashboard-builder/CustomizableTabPanel';

export function MyDashboardTab() {
  return <CustomizableTabPanel tabKey="my-dashboard" defaultWidgets={SYSTEM_DEFAULT_WIDGETS} fixedView={null} title="My Dashboard" />;
}
