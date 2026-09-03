'use client';

import { useMemo, useState } from 'react';
import { useDashboard } from '@/lib/dashboard/DashboardContext';
import { fc as fcRaw, fl as flRaw, pct, numTone, getUnitHeader } from '@/lib/utils/format';
import { DownloadBar } from '../DownloadBar';

export function ScenarioTab() {
  const { bundle, granularity, threeYear, displayUnit, presentationCurrency } = useDashboard();
  // Shadow fl()/fc() with the currently-selected table unit / active
  // Presentation Currency bound in — every existing fl(v)/fc(v) call below
  // stays unchanged.
  const fl = (n: number | null | undefined, d?: number) => flRaw(n, d, displayUnit);
  const fc = (n: number | null | undefined) => fcRaw(n, presentationCurrency);
  const unitLabel = getUnitHeader(displayUnit, presentationCurrency);
  const [revGrowth, setRevGrowth] = useState(10);
  const [costChange, setCostChange] = useState(0);
  const [empChange, setEmpChange] = useState(5);
  const [opexChange, setOpexChange] = useState(0);

  // In 3-year mode, use the latest available year's mis.totals as base
  const latestYear = granularity === '3year' && threeYear
    ? [...threeYear.years].reverse().find(y => !y.no_data && y.mis)
    : null;
  const base = latestYear ? latestYear.mis! : bundle?.mis.totals;
  const baseLabel = latestYear
    ? (latestYear.financial_year.short_label || latestYear.financial_year.label)
    : bundle?.period_label;

  const projected = useMemo(() => {
    if (!base) return null;
    const rev = base.rev * (1 + revGrowth / 100);
    const cos = base.cos * (1 + costChange / 100);
    const emp = base.emp * (1 + empChange / 100);
    const oex = base.oex * (1 + opexChange / 100);
    const gp = rev - cos;
    // Same formula as the engine's Operating EBITDA (tb-engine.ts computeMIS):
    // revenue - cost of services - employee cost - other expenses, no Other
    // Income — kept consistent so a Scenario projection is directly
    // comparable to the real EBITDA shown on Overview/MIS/Board Pack.
    const ebitda = gp - emp - oex;
    const pbt = ebitda - base.fin - base.dep;
    const tax = Math.round(pbt * 0.25);
    const pat = pbt - tax;
    return { rev, cos, gp, emp, oex, ebitda, pbt, pat, gm: rev > 0 ? gp / rev * 100 : 0, em: rev > 0 ? ebitda / rev * 100 : 0, pm: rev > 0 ? pat / rev * 100 : 0 };
  }, [base, revGrowth, costChange, empChange, opexChange]);

  function Slider({ label, value, onChange, min = -30, max = 50 }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number }) {
    return (
      <div className="sc-row">
        <span className="sc-lbl">{label}</span>
        <input type="range" min={min} max={max} value={value} onChange={e => onChange(+e.target.value)} />
        <span className="sc-val">{value > 0 ? '+' : ''}{value}%</span>
      </div>
    );
  }

  if (!base || !projected) return <div className="notice">Load report data to use the scenario planner.</div>;

  const baseEbitda = base.ebitda;

  return (
    <div>
      <DownloadBar title={`Scenario Planner & Sensitivity Model · ${baseLabel || 'FY'}`} subtitle={`Interactive What-If Financial Projections`} section="scenario" />
      <div className="info-bar">
        What-if projections start from <strong>{baseLabel}</strong> actuals and apply the adjustments below.
        Finance costs and depreciation are held constant.
        {granularity === '3year' && <span> (Using latest available year as base in 3-year view.)</span>}
      </div>
      <div className="card">
        <div className="card-hdr"><span className="ct">Scenario Inputs</span></div>
        <div className="card-body">
          <Slider label="Revenue growth" value={revGrowth} onChange={setRevGrowth} />
          <Slider label="Cost of Services change" value={costChange} onChange={setCostChange} />
          <Slider label="Employee cost change" value={empChange} onChange={setEmpChange} />
          <Slider label="Other Opex change" value={opexChange} onChange={setOpexChange} />
          <button className="btn btn-se btn-sm" onClick={() => { setRevGrowth(10); setCostChange(0); setEmpChange(5); setOpexChange(0); }}>Reset</button>
        </div>
      </div>
      <div className="so-grid">
        <div className="so-item"><div className="so-lbl">Projected Revenue</div><div className="so-val">{fc(projected.rev)}</div></div>
        <div className="so-item"><div className="so-lbl">Projected EBITDA</div><div className={`so-val ${numTone(projected.ebitda)}`}>{fc(projected.ebitda)}</div></div>
        <div className="so-item"><div className="so-lbl">Projected PAT</div><div className={`so-val ${numTone(projected.pat)}`}>{fc(projected.pat)}</div></div>
      </div>
      <div className="card">
        <div className="card-hdr"><span className="ct">Actual vs Projected</span><span className="cbadge cb-blue">{unitLabel}</span></div>
        <table className="fc-table">
          <thead><tr><th>Metric</th><th className="num">Actual</th><th className="num">Projected</th><th className="num">Δ</th></tr></thead>
          <tbody>
            <tr><td>Revenue</td><td className="num">{fl(base.rev)}</td><td className="num">{fl(projected.rev)}</td><td className={`num ${numTone(projected.rev - base.rev)}`}>{fl(projected.rev - base.rev)}</td></tr>
            <tr><td>EBITDA</td><td className={`num ${numTone(baseEbitda)}`}>{fl(baseEbitda)}</td><td className={`num ${numTone(projected.ebitda)}`}>{fl(projected.ebitda)}</td><td className={`num ${numTone(projected.ebitda - baseEbitda)}`}>{fl(projected.ebitda - baseEbitda)}</td></tr>
            <tr><td>PAT</td><td className={`num ${numTone(base.pat)}`}>{fl(base.pat)}</td><td className={`num ${numTone(projected.pat)}`}>{fl(projected.pat)}</td><td className={`num ${numTone(projected.pat - base.pat)}`}>{fl(projected.pat - base.pat)}</td></tr>
            <tr><td>Gross Margin %</td><td className="num">{pct(base.gm)}</td><td className="num">{pct(projected.gm)}</td><td className={`num ${numTone(projected.gm - base.gm)}`}>{pct(projected.gm - base.gm)}</td></tr>
            <tr><td>EBITDA Margin %</td><td className={`num ${numTone(base.em)}`}>{pct(base.em)}</td><td className={`num ${numTone(projected.em)}`}>{pct(projected.em)}</td><td className={`num ${numTone(projected.em - base.em)}`}>{pct(projected.em - base.em)}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
