'use client';

/**
 * Current-vs-Prior-Year grouped bar chart for a handful of same-unit ratios
 * (e.g. the Profitability margins, all %). Ratio Analysis previously had no
 * chart of any kind — every other figure was a static gauge-bar row — even
 * though computeRatios() already returns a `previous` figure for every
 * metric once prev_ratios is available (see RatiosTab.tsx). Deliberately
 * generic over `labels`/`current`/`prior` rather than hardcoded to margins,
 * so it stays reusable if another same-unit ratio group needs the same
 * comparison later.
 */
import { useEffect } from 'react';
import { Bar } from 'react-chartjs-2';
import { ensureChartsRegistered } from '@/lib/client/chart-register';

export function RatioComparisonChart({
  labels, current, prior, currentLabel, priorLabel, valueSuffix = '%',
}: {
  labels: string[];
  current: number[];
  prior: number[];
  currentLabel: string;
  priorLabel: string;
  valueSuffix?: string;
}) {
  useEffect(() => { ensureChartsRegistered(); }, []);
  return (
    <Bar
      data={{
        labels,
        datasets: [
          { label: priorLabel, data: prior, backgroundColor: '#CBD5E1', borderRadius: 3 },
          { label: currentLabel, data: current, backgroundColor: '#1E3A8A', borderRadius: 3 },
        ],
      }}
      options={{
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { ticks: { font: { size: 10 }, callback: (v) => `${v}${valueSuffix}` }, grid: { color: 'rgba(128,128,128,0.07)' } },
          x: { ticks: { font: { size: 10 } }, grid: { display: false } },
        },
      }}
    />
  );
}
