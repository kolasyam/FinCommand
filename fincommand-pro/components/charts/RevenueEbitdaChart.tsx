'use client';

import { useEffect } from 'react';
import { Bar } from 'react-chartjs-2';
import { ensureChartsRegistered } from '@/lib/charts/register';
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
        plugins: { legend: { display: false } },
        scales: {
          y: { ticks: { font: { size: 10 }, callback: (v) => fl(Number(v), 2, unit) }, grid: { color: 'rgba(128,128,128,0.07)' } },
          x: { ticks: { font: { size: 10 }, maxRotation: 40 }, grid: { display: false } },
        },
      }}
    />
  );
}
