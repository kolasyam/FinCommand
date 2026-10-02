'use client';

/**
 * Caches every customizable tab's layout state in one place, fetched ONCE
 * per session via GET /api/v1/dashboard-layout/all, so switching between
 * the 8 generalized tabs (plus "My Dashboard") never fires a fresh
 * per-tab network request — a small dedicated provider (same scale as
 * ToastContext.tsx), not folded into the already-busy DashboardContext.
 *
 * Failure here must fail SILENTLY toward "no customization" — a
 * customization-layer outage must never surface an error banner over a
 * report a CFO is trying to read; CustomizableTabPanel treats "no cached
 * entry" as "show the tab's real fixed view", which is exactly the correct,
 * safe behavior whether the cache is empty because nothing's saved or
 * because the fetch failed.
 */
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useDashboard } from './DashboardContext';
import {
  fetchAllTabLayouts, fetchTabLayout, saveTabLayout, resetTabLayout, saveCompanyDefaultTabLayout,
  fetchCustomMetrics, type DashboardLayoutResponse,
} from './dashboard-builder-api';
import type { DashboardWidget, TabKey } from '@/lib/financial/dashboard-builder-engine';
import type { CustomMetricDefinition } from '@/lib/financial/custom-metric-engine';

interface TabCustomizationsContextValue {
  getTabState: (tabKey: TabKey) => DashboardLayoutResponse | undefined;
  /** True once the initial batch fetch has settled (success or failure) — only meaningful for 'my-dashboard', which has no fixedView of its own to fall back to while this is still false. */
  loaded: boolean;
  /** This company's custom metrics (see lib/financial/custom-metric-engine.ts) — fetched once alongside the layouts, since both the widget picker and resolveAnyMetric() need the same list. [] (not an error) for a company that hasn't defined any. */
  customMetrics: CustomMetricDefinition[];
  refreshCustomMetrics: () => Promise<void>;
  save: (tabKey: TabKey, widgets: DashboardWidget[]) => Promise<DashboardLayoutResponse>;
  reset: (tabKey: TabKey) => Promise<void>;
  saveCompanyDefault: (tabKey: TabKey, widgets: DashboardWidget[]) => Promise<DashboardLayoutResponse>;
  /** Fetches one tab's state if it isn't cached yet — e.g. a custom tab created (with a template/copied layout) after this session's one batch fetch. */
  ensureTabState: (tabKey: TabKey) => void;
}

const Ctx = createContext<TabCustomizationsContextValue | null>(null);

export function TabCustomizationsProvider({ children }: { children: React.ReactNode }) {
  const { dataMode, user } = useDashboard();
  const [cache, setCache] = useState<Partial<Record<TabKey, DashboardLayoutResponse>>>({});
  const [customMetrics, setCustomMetrics] = useState<CustomMetricDefinition[]>([]);
  const [loaded, setLoaded] = useState(false);

  const loadCustomMetrics = useCallback(async () => {
    try {
      const res = await fetchCustomMetrics();
      setCustomMetrics(res.metrics);
    } catch {
      // Same fail-silently-toward-nothing-customized convention — a company
      // with no custom metrics (or a failed fetch) just sees the built-in
      // catalog, never an error over the report itself.
      setCustomMetrics([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (dataMode !== 'api') {
      // Sample mode never has real customizations (same convention as
      // ReportBuilderTab/MyDashboardTab) — every tab just shows its fixed view.
      setCache({});
      setCustomMetrics([]);
      setLoaded(true);
      return;
    }
    setLoaded(false);
    Promise.all([fetchAllTabLayouts(), fetchCustomMetrics().catch(() => ({ metrics: [] }))])
      .then(([layouts, metrics]) => {
        if (cancelled) return;
        setCache(layouts);
        setCustomMetrics(metrics.metrics);
      })
      .catch(() => { /* fail toward fixed views, silently — see this file's header comment */ })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [dataMode, user?.company_id]);

  const getTabState = useCallback((tabKey: TabKey) => cache[tabKey], [cache]);

  // The batch fetch above only knows the tabs that existed at page load. A
  // tab created afterward (possibly seeded from a template or a copied tab,
  // so it is NOT empty) is fetched on first view — once, de-duplicated; a
  // failure caches 'none' so it can't retry in a loop.
  const inflight = useRef(new Set<TabKey>());
  const ensureTabState = useCallback((tabKey: TabKey) => {
    if (inflight.current.has(tabKey)) return;
    inflight.current.add(tabKey);
    fetchTabLayout(tabKey)
      .then((res) => setCache((prev) => (prev[tabKey] ? prev : { ...prev, [tabKey]: res })))
      .catch(() => setCache((prev) => (prev[tabKey] ? prev : { ...prev, [tabKey]: { source: 'none', layout_cols: 12, row_height_px: 40, widgets: [] } })))
      .finally(() => { inflight.current.delete(tabKey); });
  }, []);

  const save = useCallback(async (tabKey: TabKey, widgets: DashboardWidget[]) => {
    const res = await saveTabLayout(tabKey, widgets);
    setCache((prev) => ({ ...prev, [tabKey]: res }));
    return res;
  }, []);

  const reset = useCallback(async (tabKey: TabKey) => {
    await resetTabLayout(tabKey);
    // Re-fetch just this one tab's fallback state (company default, or
    // none) rather than guessing it locally — Reset is a rare, deliberate
    // action, so the extra round trip here is worth the correctness.
    const fresh = await fetchTabLayout(tabKey);
    setCache((prev) => ({ ...prev, [tabKey]: fresh }));
  }, []);

  const saveCompanyDefault = useCallback(async (tabKey: TabKey, widgets: DashboardWidget[]) => {
    const res = await saveCompanyDefaultTabLayout(tabKey, widgets);
    // The caller's OWN view only changes if they had no personal layout on
    // this tab — a personal layout still wins over the new company default
    // (the server's 3-tier fallback), so overwriting the cache here would
    // mislabel their view as "company default" and hide Reset until reload.
    setCache((prev) => (prev[tabKey]?.source === 'personal' ? prev : { ...prev, [tabKey]: res }));
    return res;
  }, []);

  const value: TabCustomizationsContextValue = {
    getTabState, loaded, customMetrics, refreshCustomMetrics: loadCustomMetrics,
    save, reset, saveCompanyDefault, ensureTabState,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * The company's custom metric list shared by EVERY consumer — widget
 * picker/inspector/values, the metric builder, and the "Manage custom
 * metrics" modal. Whoever creates/edits/deletes/restores a metric calls
 * `refreshCustomMetrics()` so every open tab sees the change immediately
 * (the modal previously refreshed only a private copy, so widgets kept
 * showing a deleted or pre-edit metric until a full page reload).
 */
export function useCustomMetricsList() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useCustomMetricsList must be used within TabCustomizationsProvider');
  return { customMetrics: ctx.customMetrics, refreshCustomMetrics: ctx.refreshCustomMetrics };
}

export function useTabCustomization(tabKey: TabKey) {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTabCustomization must be used within TabCustomizationsProvider');
  return {
    state: ctx.getTabState(tabKey),
    loaded: ctx.loaded,
    customMetrics: ctx.customMetrics,
    refreshCustomMetrics: ctx.refreshCustomMetrics,
    save: (widgets: DashboardWidget[]) => ctx.save(tabKey, widgets),
    reset: () => ctx.reset(tabKey),
    saveCompanyDefault: (widgets: DashboardWidget[]) => ctx.saveCompanyDefault(tabKey, widgets),
    ensureLoaded: () => ctx.ensureTabState(tabKey),
  };
}
