'use client';

/**
 * Revenue / EBITDA / PAT grouped monthly bar chart — same 3-series shape and
 * colors as the bespoke MIS PDF's own native "Monthly Trend" chart
 * (lib/exports/mis-pdf.ts's drawMisTrendChart()), which previously only
 * existed on download. Same simple <Bar> convention as Overview's own
 * RevenueEbitdaChart, extended to a third series.
 */
import { useEffect } from 'react';
import { Bar } from 'react-chartjs-2';
import { ensureChartsRegistered } from '@/lib/client/chart-register';
import { fl, type DisplayUnit } from '@/lib/utils/format';

export function MisTrendChart({
  labels, revenue, ebitda, pat, unit = 'Lakhs',
}: {
  labels: string[]; revenue: number[]; ebitda: number[]; pat: number[]; unit?: DisplayUnit;
}) {
  useEffect(() => { ensureChartsRegistered(); }, []);
  return (
    <Bar
      data={{
        labels,
        datasets: [
          { label: 'Revenue', data: revenue, backgroundColor: '#B5D4F4', borderRadius: 3 },
          { label: 'EBITDA', data: ebitda, backgroundColor: '#5DCAA5', borderRadius: 3 },
          { label: 'PAT', data: pat, backgroundColor: '#1E3A8A', borderRadius: 3 },
        ],
      }}
      options={{
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          // Previously no tooltip callback at all — Chart.js's default
          // showed the raw, un-scaled rupee value, ignoring the Unit
          // Selector entirely even though the Y-axis ticks right next to it
          // correctly rescale. Same fl()-based callback
          // RevenueEbitdaChart.tsx/WaterfallChart.tsx already use.
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${fl(ctx.raw as number, 2, unit)}`,
            },
          },
        },
        scales: {
          y: { ticks: { font: { size: 10 }, callback: (v) => fl(Number(v), 2, unit) }, grid: { color: 'rgba(128,128,128,0.07)' } },
          x: { ticks: { font: { size: 10 }, maxRotation: 40 }, grid: { display: false } },
        },
      }}
    />
  );
}
