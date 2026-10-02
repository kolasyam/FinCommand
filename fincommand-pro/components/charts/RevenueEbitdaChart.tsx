'use client';

import { useEffect } from 'react';
import { Bar } from 'react-chartjs-2';
import { ensureChartsRegistered } from '@/lib/client/chart-register';
import { fl, type DisplayUnit } from '@/lib/utils/format';

export function RevenueEbitdaChart({ labels, revenue, ebitda, unit = 'Lakhs' }: { labels: string[]; revenue: number[]; ebitda: number[]; unit?: DisplayUnit }) {
  useEffect(() => { ensureChartsRegistered(); }, []);
  return (
    <Bar
      data={{
        labels,
        datasets: [
          { label: 'Revenue', data: revenue, backgroundColor: '#B5D4F4', borderRadius: 3 },
          { label: 'EBITDA', data: ebitda, backgroundColor: '#5DCAA5', borderRadius: 3 },
        ],
      }}
      options={{
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          // Previously no tooltip callback at all — Chart.js's default
          // showed the raw, un-scaled rupee value (e.g. "32475872.45"),
          // ignoring the Unit Selector entirely even though the Y-axis
          // ticks right next to it correctly show "324.76" under Lakhs.
          // Same fl()-based callback WaterfallChart.tsx/widget-renderers.tsx's
          // MultiSeriesWidget already use for their own tooltips.
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
