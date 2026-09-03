'use client';

import { useEffect } from 'react';
import { Line } from 'react-chartjs-2';
import { ensureChartsRegistered } from '@/lib/charts/register';

export function MarginTrendChart({ labels, gm, em, pm }: { labels: string[]; gm: number[]; em: number[]; pm: number[] }) {
  useEffect(() => { ensureChartsRegistered(); }, []);
  return (
    <Line
      data={{
        labels,
        datasets: [
          { label: 'GM%', data: gm, borderColor: '#378ADD', tension: .3, pointRadius: 3, fill: false, borderWidth: 2 },
          { label: 'EBITDA%', data: em, borderColor: '#1D9E75', tension: .3, pointRadius: 3, fill: false, borderWidth: 2 },
          { label: 'PAT%', data: pm, borderColor: '#EF9F27', tension: .3, pointRadius: 3, fill: false, borderWidth: 2 },
        ],
      }}
      options={{
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          // Tooltips always read the real underlying data point, not the
          // axis-clamped visual position — so a genuine -600% month (from
          // dividing a near-zero-revenue month's expenses) still shows its
          // true value on hover even though the line itself flattens at
          // the ±100% boundary below instead of dragging the whole axis
          // down and flattening every other, normal month.
          tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${(ctx.raw as number).toFixed(1)}%` } },
        },
        scales: {
          // Fixed bounds prevent one extreme low-revenue month from
          // rescaling the whole Y-axis (e.g. down to -700%) and flattening
          // every normal month's trend into an unreadable flat line.
          y: { min: -100, max: 100, ticks: { font: { size: 10 }, stepSize: 25, callback: (v) => v + '%' }, grid: { color: 'rgba(128,128,128,0.07)' } },
          x: { ticks: { font: { size: 10 }, maxRotation: 40 }, grid: { display: false } },
        },
      }}
    />
  );
}
