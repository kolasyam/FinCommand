'use client';

/**
 * Thin apiFetch() wrappers for the custom-tab entity endpoints — a custom
 * tab's identity (name/description/icon) and sharing are company-wide state,
 * not tied to the global PeriodBar's FY+period selection.
 */
import { apiFetch } from './api-client';
import type { TabVisibility } from '@/lib/dashboard-builder/tab-access';

export interface CustomTabDTO {
  id: string;
  companyId: string;
  tabKey: string;
  name: string;
  description: string | null;
  icon: string | null;
  sortOrder: number;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  visibility: TabVisibility;
  sharedRoles: string[];
  /** 'template:<key>' or 'tab:<tabKey>' the tab started from — provenance only. */
  startedFrom: string | null;
  /** Saved dashboard_layouts rows (personal + company-default) under this tab's key — shown before delete. */
  layoutCount: number;
}

/** Only the tabs shared with the caller — the server filters. */
export function fetchCustomTabs() {
  return apiFetch<{ tabs: CustomTabDTO[] }>('/custom-tabs');
}

export interface CreateCustomTabInput {
  name: string;
  description?: string;
  icon?: string;
  visibility?: TabVisibility;
  sharedRoles?: string[];
  /** Gallery template key (lib/dashboard-builder/templates.ts) — mutually exclusive with copyFromTabKey. */
  template?: string;
  /** Any tab the caller can see — its current view becomes the new tab's starting layout. */
  copyFromTabKey?: string;
}

/** admin/cfo only — the server re-checks. Nothing exists until this call succeeds; the tab and its starting layout are created together. */
export function createCustomTab(input: CreateCustomTabInput) {
  return apiFetch<{ tab: CustomTabDTO }>('/custom-tabs', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export interface UpdateCustomTabInput {
  name?: string;
  description?: string | null;
  icon?: string | null;
  sortOrder?: number;
  visibility?: TabVisibility;
  sharedRoles?: string[];
}

/** admin/cfo only. tab_key is never accepted — it's immutable once created. */
export function updateCustomTab(id: string, input: UpdateCustomTabInput) {
  return apiFetch<{ tab: CustomTabDTO }>(`/custom-tabs/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

/** admin/cfo only. Also deletes every saved layout under this tab's key — the response's layouts_removed count is what to show back. */
export function deleteCustomTab(id: string) {
  return apiFetch<{ message: string; layouts_removed: number }>(`/custom-tabs/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
