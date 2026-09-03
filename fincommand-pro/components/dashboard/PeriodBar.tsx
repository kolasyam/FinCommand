'use client';

import { useDashboard, type Granularity } from '@/lib/dashboard/DashboardContext';
import type { Period, YearType } from '@/lib/financial/tb-engine';
import type { FyLike } from '@/lib/dashboard/types';

const QUARTERS: { key: Period; sub: string }[] = [
  { key: 'Q1', sub: 'Apr-Jun' }, { key: 'Q2', sub: 'Jul-Sep' }, { key: 'Q3', sub: 'Oct-Dec' }, { key: 'Q4', sub: 'Jan-Mar' },
];
const QUARTERS_CY: { key: Period; sub: string }[] = [
  { key: 'Q1', sub: 'Jan-Mar' }, { key: 'Q2', sub: 'Apr-Jun' }, { key: 'Q3', sub: 'Jul-Sep' }, { key: 'Q4', sub: 'Oct-Dec' },
];
const HALVES: { key: Period; sub: string }[] = [{ key: 'H1', sub: 'Apr-Sep' }, { key: 'H2', sub: 'Oct-Mar' }];
const HALVES_CY: { key: Period; sub: string }[] = [{ key: 'H1', sub: 'Jan-Jun' }, { key: 'H2', sub: 'Jul-Dec' }];

/**
 * Derive the Calendar Year number from an FY's dates.
 * For Indian FY (Apr–Mar): CY year = end_date year.
 *   FY25 ends 2025-03-31 → CY2025
 *   FY24 ends 2024-03-31 → CY2024
 */
function cyYearFromFy(fy: FyLike): number {
  if (fy.end_date) return parseInt(fy.end_date.slice(0, 4), 10);
  return parseInt(fy.start_date.slice(0, 4), 10) + 1;
}

/** Returns the short label for a given year type. */
function fyPillLabel(fy: FyLike, yearType: YearType): string {
  if (yearType === 'CY') return `CY${cyYearFromFy(fy)}`;
  return fy.short_label || fy.label;
}

export function PeriodBar() {
  const { yearType, granularity, subPeriod, setYearType, setGranularity, setSubPeriod, fyList, currentFyId, selectFy, bundle } = useDashboard();

  const currentFy = fyList.find(f => f.id === currentFyId);
  // In CY mode, the calendar year actually shown can differ from a naive
  // guess off the clicked FY pill: when there's no later FY uploaded yet to
  // supply Apr–Dec, the backend falls back to stitching the *prior* year's
  // Jan–Mar with the selected FY's Apr–Dec instead of returning a mostly-
  // empty year (see app/api/v1/reports/all/route.ts's `cyLabelFy`). Once
  // `bundle` has loaded, its `financial_year` reflects whichever FY the
  // returned data was actually built from — prefer that over the client-side
  // guess so this header can't show a different CY year than the tab below it.
  const cyLabelFy = (yearType === 'CY' && bundle?.financial_year) ? bundle.financial_year : currentFy;

  function buildSummary(): string {
    // In CY mode replace FY label with CY label (e.g. "CY2024 · Annual")
    const base = cyLabelFy
      ? (yearType === 'CY' ? `CY${cyYearFromFy(cyLabelFy)}` : (currentFy?.label || ''))
      : '';

    if (granularity === '3year') return base ? `${base.split(' ')[0]}s · 3-Year` : '3-Year';
    if (granularity === 'annual') return `${base} · Annual`;
    if (granularity === 'quarterly') return subPeriod ? `${base} ${subPeriod}` : `${base} · Quarterly`;
    if (granularity === 'halfyear') return subPeriod ? `${base} ${subPeriod}` : `${base} · H1/H2`;
    return base;
  }

  const summary = buildSummary();
  const yearFys = fyList.filter(f => !f.year_type || f.year_type === yearType);
  const listForYearPills = (yearFys.length ? yearFys : fyList).slice(0, 3);

  return (
    <div className="pbar">
      <div className="pb-grp">
        <span className="pb-lbl">Year</span>
        <button className={`pbp yt${yearType === 'FY' ? ' on' : ''}`} onClick={() => setYearType('FY')}>FY</button>
        <button className={`pbp yt${yearType === 'CY' ? ' on' : ''}`} onClick={() => setYearType('CY')}>CY</button>
      </div>
      <div className="pb-sep" />
      <div className="pb-grp">
        <span className="pb-lbl">View</span>
        {(['annual', '3year', 'halfyear', 'quarterly'] as Granularity[]).map(gr => (
          <button key={gr} className={`pbp${granularity === gr ? ' on' : ''}`} onClick={() => setGranularity(gr)}>
            {gr === 'annual' ? 'Annual' : gr === '3year' ? '3 Years' : gr === 'halfyear' ? 'H1 / H2' : 'Quarterly'}
          </button>
        ))}
      </div>
      {granularity !== '3year' && (
        <>
          <div className="pb-sep" />
          <div className="pb-grp">
            <span className="pb-lbl">Period</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {listForYearPills.map(fy => (
                <button
                  key={fy.id}
                  className={`pbp${fy.id === currentFyId ? ' on' : ''}`}
                  onClick={() => selectFy(fy.id)}
                  title={yearType === 'CY'
                    ? `CY${cyYearFromFy(fy)}: Jan–Mar from ${fy.label}, Apr–Dec from next FY`
                    : fy.label}
                >
                  {fyPillLabel(fy, yearType)}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
      {(granularity === 'quarterly' || granularity === 'halfyear') && (
        <>
          <div className="pb-sep" />
          <div className="pb-grp">
            <div style={{ display: 'flex', gap: 4 }}>
              {(granularity === 'quarterly' ? (yearType === 'FY' ? QUARTERS : QUARTERS_CY) : (yearType === 'FY' ? HALVES : HALVES_CY))
                .map(({ key, sub }) => (
                  <button key={key} className={`pbp sub${subPeriod === key ? ' on' : ''}`} onClick={() => setSubPeriod(key)}>
                    {key} <span style={{ fontSize: 9, opacity: .7 }}>{sub}</span>
                  </button>
                ))}
            </div>
          </div>
        </>
      )}
      <span className="pb-summary">{summary}</span>
    </div>
  );
}
