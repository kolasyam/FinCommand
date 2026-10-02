'use client';

/**
 * Caches this company's custom dashboard tabs in one place, fetched once per
 * session — same small-dedicated-provider scale as TabCustomizationsContext,
 * not folded into the already-busy DashboardContext. Sibling to, not part
 * of, TabCustomizationsContext: that one caches per-tab *layout* state,
 * this one caches the tab *entities* themselves (name/description/icon).
 *
 * Failure here fails SILENTLY toward "no custom tabs" — same convention as
 * TabCustomizationsContext's own header comment: an outage in this layer
 * must never surface an error banner over a report someone's trying to
 * read; it just means the sidebar's custom-tabs section renders empty.
 */
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useDashboard } from './DashboardContext';
import {
  fetchCustomTabs, createCustomTab as apiCreateCustomTab, updateCustomTab as apiUpdateCustomTab,
  deleteCustomTab as apiDeleteCustomTab,
  type CustomTabDTO, type CreateCustomTabInput, type UpdateCustomTabInput,
} from './custom-tabs-api';

interface CustomTabsContextValue {
  tabs: CustomTabDTO[];
  /** True once the initial fetch has settled (success or failure). */
  loaded: boolean;
  createTab: (input: CreateCustomTabInput) => Promise<CustomTabDTO>;
  /** Rename and/or re-share. */
  updateTab: (id: string, input: UpdateCustomTabInput) => Promise<CustomTabDTO>;
  deleteTab: (id: string) => Promise<{ layoutsRemoved: number }>;
}

const Ctx = createContext<CustomTabsContextValue | null>(null);

export function CustomTabsProvider({ children }: { children: React.ReactNode }) {
  const { dataMode, user } = useDashboard();
  const [tabs, setTabs] = useState<CustomTabDTO[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (dataMode !== 'api') {
      // Sample mode never has real custom tabs — same convention every
      // other dashboard-builder context follows.
      setTabs([]);
      setLoaded(true);
      return;
    }
    setLoaded(false);
    fetchCustomTabs()
      .then((res) => { if (!cancelled) setTabs(res.tabs); })
      .catch(() => { /* fail toward an empty custom-tabs list, silently — see this file's header comment */ })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [dataMode, user?.company_id]);

  const createTab = useCallback(async (input: CreateCustomTabInput) => {
    const res = await apiCreateCustomTab(input);
    setTabs((prev) => [...prev, res.tab]);
    return res.tab;
  }, []);

  const updateTab = useCallback(async (id: string, input: UpdateCustomTabInput) => {
    const res = await apiUpdateCustomTab(id, input);
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...res.tab } : t)));
    return res.tab;
  }, []);

  const deleteTab = useCallback(async (id: string) => {
    const res = await apiDeleteCustomTab(id);
    setTabs((prev) => prev.filter((t) => t.id !== id));
    return { layoutsRemoved: res.layouts_removed };
  }, []);

  const value: CustomTabsContextValue = { tabs, loaded, createTab, updateTab, deleteTab };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCustomTabs() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useCustomTabs must be used within CustomTabsProvider');
  return ctx;
}
