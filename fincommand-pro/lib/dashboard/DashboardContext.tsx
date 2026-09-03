'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  apiFetch, ApiClientError, clearSession, getRefreshToken, getStoredFyId, getStoredUser, getToken,
  storeSession, setStoredFyId, type StoredUser,
} from './api-client';
import { computeLocalReportBundle, computeLocalThreeYear } from './compute-local';
import { SAMPLE_FY_META, SAMPLE_FY_ORDER, type SampleFyKey } from '@/lib/financial/sample-data';
import type { PeriodParams, PeriodType, YearType, Period } from '@/lib/financial/tb-engine';
import type { DisplayUnit } from '@/lib/utils/format';
import type { FyLike, ReportBundle, ThreeYearBundle } from './types';
import { type CurrencyCode, type FxRate } from '@/lib/services/currency';
import { convertReportBundle, convertThreeYearBundle } from '@/lib/financial/currency-convert';

export type DataMode = 'sample' | 'api';
export type Granularity = 'annual' | '3year' | 'halfyear' | 'quarterly';

const DISPLAY_UNIT_STORAGE_KEY = 'fc_display_unit';
const PRESENTATION_CURRENCY_STORAGE_KEY = 'fc_presentation_currency';
const CURRENCY_CODES: CurrencyCode[] = ['INR', 'USD', 'EUR', 'GBP', 'AED'];
function isCurrencyCodeLocal(v: unknown): v is CurrencyCode {
  return typeof v === 'string' && (CURRENCY_CODES as string[]).includes(v);
}

interface DashboardState {
  dataMode: DataMode;
  user: StoredUser | null;
  fyList: FyLike[];
  currentFyId: string | null;
  yearType: YearType;
  granularity: Granularity;
  subPeriod: Period;
  /** Table display unit (Lakhs/Thousands/Crores) — a pure presentation preference, doesn't refetch report data. Persisted per-browser via localStorage. */
  displayUnit: DisplayUnit;
  /**
   * Source Currency — the currency this company's Trial Balance ledgers are
   * actually recorded in (real, from `bundle.source_currency`; 'INR' before
   * a bundle has loaded, matching the DB column's own default). Read-only
   * here — it's a fact about the data, not a user preference.
   */
  sourceCurrency: CurrencyCode | string;
  /** Presentation Currency the dashboard/exports DISPLAY figures in — independent of sourceCurrency, a pure presentation preference like displayUnit, persisted per-browser. Seeded from the company's saved default (bundle.default_presentation_currency) the first time a bundle loads, then a user override always wins. */
  presentationCurrency: CurrencyCode;
  /** Spot rate to convert sourceCurrency -> presentationCurrency (multiply by this). 1 when they're equal (no conversion needed) or the rate hasn't loaded yet. */
  fxRate: number;
  /** When the active fxRate was last updated by its provider — always shown alongside any converted figure (IAS 21 / IND AS 21 disclosure: this is a spot rate, not a certified daily rate). Null when sourceCurrency === presentationCurrency (no conversion, nothing to disclose). */
  fxAsOf: string | null;
  fxLoading: boolean;
  /** Set when a live rate genuinely couldn't be fetched — bundle stays in sourceCurrency (fxRate defaults to 1) rather than ever guessing a rate; the UI must disclose this, not silently show wrong-currency figures as if they were converted. */
  fxError: string | null;
  /** `bundle` is already converted to the active presentationCurrency (see convertReportBundle()) — every tab and export reads real, correctly-converted figures with no changes of their own needed. */
  bundle: ReportBundle | null;
  threeYear: ThreeYearBundle | null;
  loading: boolean;
  error: string | null;
  booting: boolean;
  /**
   * Cross-tab navigation signal — set by navigateToNote() when a Note
   * reference (Balance Sheet / P&L) is clicked. DashboardShell (which owns
   * the actual active-tab state, outside this context) watches
   * `requestedTab` and switches to it, then calls clearRequestedTab().
   * NotesTab separately watches `pendingNoteKey` to scroll to and highlight
   * the right note card, then calls clearPendingNoteKey() — kept as two
   * independent pieces of state (rather than one "switch tabs" side effect)
   * because the tab switch must happen before Notes to Accounts has even
   * mounted, while the scroll can only happen after it has.
   */
  requestedTab: string | null;
  pendingNoteKey: string | null;
  /** `noteKey` matches Notes to Accounts' own note identity convention: `bs_${note_no}` or `pl_${note_no}` — required (not just the bare number) since a note_no can legitimately mean two different notes depending on section (e.g. Note 20 = Revenue on the P&L side, Bank Balances/FDs on the Balance Sheet side). */
  navigateToNote: (noteKey: string) => void;
  clearRequestedTab: () => void;
  clearPendingNoteKey: () => void;

  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  useSampleData: () => void;
  selectFy: (id: string) => void;
  setYearType: (yt: YearType) => void;
  setGranularity: (gr: Granularity) => void;
  setSubPeriod: (p: Period) => void;
  setDisplayUnit: (u: DisplayUnit) => void;
  setPresentationCurrency: (c: CurrencyCode) => void;
  refresh: () => void;
  uploadComplete: () => void;
  loadFyList: () => Promise<FyLike[]>;
}

const DashboardCtx = createContext<DashboardState | null>(null);

function sampleKeyForFyId(fyId: string | null): SampleFyKey {
  const found = SAMPLE_FY_ORDER.find(k => SAMPLE_FY_META[k].id === fyId);
  return found || 'FY25';
}

export function DashboardProvider({ children }: { children: React.ReactNode }) {
  const [dataMode, setDataMode] = useState<DataMode>('sample');
  const [user, setUser] = useState<StoredUser | null>(null);
  const [fyList, setFyList] = useState<FyLike[]>([]);
  const [currentFyId, setCurrentFyId] = useState<string | null>(null);
  const [yearType, setYearTypeState] = useState<YearType>('FY');
  const [granularity, setGranularityState] = useState<Granularity>('annual');
  const [subPeriod, setSubPeriodState] = useState<Period>(null);
  // Always boot at the 'Lakhs' default on both server and first client render
  // (avoids a hydration mismatch) — the real stored preference, if any, is
  // applied a moment later from an effect that only runs in the browser.
  const [displayUnit, setDisplayUnitState] = useState<DisplayUnit>('Lakhs');
  const [requestedTab, setRequestedTab] = useState<string | null>(null);
  const [pendingNoteKey, setPendingNoteKey] = useState<string | null>(null);
  // The bundle exactly as fetched/computed — always in Source Currency.
  // `bundle` (exposed to consumers) is derived from this + the active FX
  // rate below via convertReportBundle(), so every tab/export reads
  // already-converted figures without needing to know about currency at all.
  const [rawBundle, setRawBundle] = useState<ReportBundle | null>(null);
  const [rawThreeYear, setThreeYear] = useState<ThreeYearBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);

  // Always boot at 'INR' on both server and first client render (avoids a
  // hydration mismatch), same reasoning as displayUnit above — the real
  // stored preference, if any, is applied a moment later, browser-only.
  const [presentationCurrency, setPresentationCurrencyState] = useState<CurrencyCode>('INR');
  const [fxRate, setFxRate] = useState(1);
  const [fxAsOf, setFxAsOf] = useState<string | null>(null);
  const [fxLoading, setFxLoading] = useState(false);
  const [fxError, setFxError] = useState<string | null>(null);

  // ── Boot: restore session synchronously on client mount if a token is present ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = getToken();
      const storedUser = getStoredUser();
      const storedFy = getStoredFyId();

      if (token && storedUser) {
        // Immediately restore session context on client mount to prevent flashing sample data
        setDataMode('api');
        setUser(storedUser);
        if (storedFy) setCurrentFyId(storedFy);
        setLoading(true);

        try {
          const freshUser = await apiFetch<StoredUser>('/auth/me');
          if (!cancelled) {
            setUser(freshUser);
            if (typeof window !== 'undefined') window.localStorage.setItem('fc_user', JSON.stringify(freshUser));
            await loadFyList();
          }
        } catch {
          if (!cancelled) {
            clearSession();
            setDataMode('sample');
            setUser(null);
            setFyList(Object.values(SAMPLE_FY_META));
            setCurrentFyId(SAMPLE_FY_META.FY25.id);
            setLoading(false);
          }
        } finally {
          if (!cancelled) setBooting(false);
        }
      } else {
        if (!cancelled) {
          setDataMode('sample');
          setUser(null);
          setFyList(Object.values(SAMPLE_FY_META));
          setCurrentFyId(SAMPLE_FY_META.FY25.id);
          setLoading(false);
          setBooting(false);
        }
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadFyList = useCallback(async () => {
    const list = await apiFetch<FyLike[]>('/fy');
    setFyList(list);
    if (list.length) {
      setCurrentFyId(prev => {
        const stillValid = prev && list.some(f => f.id === prev);
        const next = stillValid ? prev! : list[0].id;
        setStoredFyId(next);
        return next;
      });
    } else {
      setCurrentFyId(null);
    }
    return list;
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');

    storeSession(data.access_token, data.refresh_token, data.user);
    setUser(data.user);
    setDataMode('api');
    setError(null);
    await loadFyList();
  }, [loadFyList]);

  const logout = useCallback(async () => {
    try {
      await apiFetch('/auth/logout', { method: 'POST', body: JSON.stringify({ refresh_token: getRefreshToken() }) });
    } catch {
      // ignore — we're clearing local session regardless
    }
    clearSession();
    setUser(null);
    setDataMode('sample');
    setFyList(Object.values(SAMPLE_FY_META));
    setCurrentFyId(SAMPLE_FY_META.FY25.id);
    setError(null);
  }, []);

  const useSampleData = useCallback(() => {
    setDataMode('sample');
    setFyList(Object.values(SAMPLE_FY_META));
    setCurrentFyId(SAMPLE_FY_META.FY25.id);
    setError(null);
  }, []);

  const selectFy = useCallback((id: string) => {
    setCurrentFyId(id);
    if (dataMode === 'api') setStoredFyId(id);
  }, [dataMode]);

  const setYearType = useCallback((yt: YearType) => { setYearTypeState(yt); setSubPeriodState(null); }, []);
  const setGranularity = useCallback((gr: Granularity) => { setGranularityState(gr); setSubPeriodState(null); }, []);
  const setSubPeriod = useCallback((p: Period) => { setSubPeriodState(prev => (prev === p ? null : p)); }, []);
  const setDisplayUnit = useCallback((u: DisplayUnit) => {
    setDisplayUnitState(u);
    if (typeof window !== 'undefined') {
      try { window.localStorage.setItem(DISPLAY_UNIT_STORAGE_KEY, u); } catch { /* private mode / storage disabled — unit just won't persist across reloads */ }
    }
  }, []);
  const refresh = useCallback(() => setRefreshTick(t => t + 1), []);
  const uploadComplete = refresh;

  const navigateToNote = useCallback((noteKey: string) => {
    setRequestedTab('notes');
    setPendingNoteKey(noteKey);
  }, []);
  const clearRequestedTab = useCallback(() => setRequestedTab(null), []);
  const clearPendingNoteKey = useCallback(() => setPendingNoteKey(null), []);

  // Restore the user's last-picked display unit once mounted in the browser
  // — a pure presentation preference, independent of session/data loading,
  // so it doesn't need to (and shouldn't) block or participate in the boot
  // sequence above.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(DISPLAY_UNIT_STORAGE_KEY);
      if (stored === 'Lakhs' || stored === 'Thousands' || stored === 'Crores') setDisplayUnitState(stored);
    } catch { /* private mode / storage disabled — stays at the 'Lakhs' default */ }
  }, []);

  const setPresentationCurrency = useCallback((c: CurrencyCode) => {
    setPresentationCurrencyState(c);
    if (typeof window !== 'undefined') {
      try { window.localStorage.setItem(PRESENTATION_CURRENCY_STORAGE_KEY, c); } catch { /* private mode / storage disabled — choice just won't persist across reloads */ }
    }
  }, []);

  // Same pattern as the Unit Selector above: restore an explicit user choice
  // from localStorage once mounted in the browser.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(PRESENTATION_CURRENCY_STORAGE_KEY);
      if (isCurrencyCodeLocal(stored)) setPresentationCurrencyState(stored);
    } catch { /* private mode / storage disabled — stays at the 'INR' default */ }
  }, []);

  // Seed the Presentation Currency from the company's own saved default
  // (Module B — set during onboarding/Company Settings) the first time a
  // bundle carrying one arrives — but ONLY if the user has no explicit
  // choice of their own already. setPresentationCurrency() below persists
  // to localStorage immediately, so this seeds at most once per browser:
  // on every later run the `stored` check finds that persisted value and
  // this effect becomes a no-op, exactly like adopting a real preference
  // rather than fighting the user's own later selector changes.
  useEffect(() => {
    const dflt = rawBundle?.default_presentation_currency;
    if (!dflt || !isCurrencyCodeLocal(dflt)) return;
    try {
      if (window.localStorage.getItem(PRESENTATION_CURRENCY_STORAGE_KEY)) return;
    } catch { /* private mode / storage disabled — fall through and seed for this session anyway */ }
    setPresentationCurrency(dflt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawBundle?.default_presentation_currency]);

  // Source Currency: a real fact about the connected company's Trial
  // Balance (see ReportBundle.source_currency's own comment) — 'INR' before
  // any bundle has loaded, matching companies.currency's own DB default.
  // While granularity === '3year', rawBundle is null (see the loader below)
  // so this reads rawThreeYear's own copy of the same fact instead — without
  // that fallback, the 3-Year Frame's FX conversion would silently assume
  // 'INR' regardless of what this company's books are actually recorded in.
  const sourceCurrency = (rawBundle?.source_currency || rawThreeYear?.source_currency || 'INR').toUpperCase();

  // ── Live FX rate, whenever Source Currency and Presentation Currency differ ──
  useEffect(() => {
    let cancelled = false;
    if (sourceCurrency === presentationCurrency) {
      setFxRate(1);
      setFxAsOf(null);
      setFxError(null);
      setFxLoading(false);
      return;
    }
    setFxLoading(true);
    setFxError(null);
    (async () => {
      try {
        const fx = await apiFetch<FxRate>(`/fx-rate?from=${encodeURIComponent(sourceCurrency)}&to=${presentationCurrency}`);
        if (cancelled) return;
        setFxRate(fx.rate);
        setFxAsOf(fx.as_of);
        setFxError(null);
      } catch (e) {
        if (cancelled) return;
        // Never guess a rate: fall back to showing the real, un-converted
        // Source Currency figures (rate 1) rather than a fabricated one —
        // fxError tells the UI to disclose this plainly rather than
        // silently rendering the wrong currency's numbers as if converted.
        setFxRate(1);
        setFxAsOf(null);
        const isApiErr = e instanceof ApiClientError;
        setFxError((isApiErr ? e.message : (e as Error).message) || 'FX rate unavailable');
      } finally {
        if (!cancelled) setFxLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sourceCurrency, presentationCurrency]);

  // The one place the whole app converts currency — every consumer of
  // `bundle` (all 14 tabs, every PDF/Excel export) reads real, already-
  // converted figures with no currency-awareness of their own required.
  // fxRate is 1 (a true no-op, convertReportBundle() short-circuits) both
  // when the two currencies are equal AND while a real rate hasn't loaded
  // yet or failed — so the dashboard never briefly flashes a half-converted
  // or fabricated figure.
  const bundle = useMemo(
    () => (rawBundle ? convertReportBundle(rawBundle, fxRate) : null),
    [rawBundle, fxRate]
  );
  const threeYear = useMemo(
    () => (rawThreeYear ? convertThreeYearBundle(rawThreeYear, fxRate) : null),
    [rawThreeYear, fxRate]
  );

  // ── Load report data whenever mode/FY/period changes ──
  useEffect(() => {
    if (booting) return;

    if (!currentFyId) {
      setLoading(false);
      setRawBundle(null);
      setThreeYear(null);
      return;
    }

    const fyId = currentFyId;
    let cancelled = false;

    async function run() {
      setLoading(true);
      setError(null);
      try {
        if (granularity === '3year') {
          if (dataMode === 'sample') {
            if (!cancelled) { setThreeYear(computeLocalThreeYear()); setRawBundle(null); }
          } else {
            const ids = fyList.slice(0, 3).map(f => f.id);
            if (ids.length === 0) throw new Error('No financial years found. Add a year and upload TB data first.');
            const tY = await apiFetch<ThreeYearBundle>(`/reports/threeyear?fy_ids=${ids.join(',')}&year_type=${yearType}`);
            if (!cancelled) { setThreeYear(tY); setRawBundle(null); }
          }
        } else {
          const periodType: PeriodType = granularity;
          const params: PeriodParams = { periodType, period: subPeriod, yearType };

          if (dataMode === 'sample') {
            const key = sampleKeyForFyId(fyId);
            if (!cancelled) { setRawBundle(computeLocalReportBundle(key, params)); setThreeYear(null); }
          } else {
            const qs = new URLSearchParams({ fy_id: fyId, period_type: periodType, year_type: yearType, nocache: 'true' });
            if (subPeriod) qs.set('period', subPeriod);
            const b = await apiFetch<ReportBundle>(`/reports/all?${qs.toString()}`);
            if (!cancelled) { setRawBundle(b); setThreeYear(null); }
          }
        }
      } catch (e) {
        if (!cancelled) {
          const isApiErr = e instanceof ApiClientError;
          const status = isApiErr ? e.status : undefined;
          const msg = isApiErr ? e.message : (e as Error).message;
          const isNoData = status === 404 || msg?.toLowerCase().includes('no trial balance data');
          if (isNoData) {
            setError(null);
          } else {
            setError(msg || 'Failed to load report data');
          }
          setRawBundle(null);
          setThreeYear(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    run();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataMode, currentFyId, yearType, granularity, subPeriod, booting, refreshTick]);

  const value = useMemo<DashboardState>(() => ({
    dataMode, user, fyList, currentFyId, yearType, granularity, subPeriod, displayUnit,
    sourceCurrency, presentationCurrency, fxRate, fxAsOf, fxLoading, fxError,
    bundle, threeYear, loading, error, booting, requestedTab, pendingNoteKey,
    login, logout, useSampleData, selectFy, setYearType, setGranularity, setSubPeriod, setDisplayUnit, setPresentationCurrency,
    navigateToNote, clearRequestedTab, clearPendingNoteKey, refresh, uploadComplete, loadFyList,
  }), [dataMode, user, fyList, currentFyId, yearType, granularity, subPeriod, displayUnit,
      sourceCurrency, presentationCurrency, fxRate, fxAsOf, fxLoading, fxError,
      bundle, threeYear, loading, error, booting, requestedTab, pendingNoteKey,
      login, logout, useSampleData, selectFy, setYearType, setGranularity, setSubPeriod, setDisplayUnit, setPresentationCurrency,
      navigateToNote, clearRequestedTab, clearPendingNoteKey, refresh, uploadComplete, loadFyList]);

  return <DashboardCtx.Provider value={value}>{children}</DashboardCtx.Provider>;
}

export function useDashboard(): DashboardState {
  const ctx = useContext(DashboardCtx);
  if (!ctx) throw new Error('useDashboard must be used within DashboardProvider');
  return ctx;
}
