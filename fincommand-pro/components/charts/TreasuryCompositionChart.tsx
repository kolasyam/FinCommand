'use client';

import { useEffect } from 'react';
import { Doughnut } from 'react-chartjs-2';
import { ensureChartsRegistered } from '@/lib/charts/register';

const COLORS = ['#EF9F27', '#378ADD', '#93C5FD', '#1D9E75', '#5DCAA5'];

export function TreasuryCompositionChart({ labels, values }: { labels: string[]; values: number[] }) {
  useEffect(() => { ensureChartsRegistered(); }, []);
  // Only chart instruments that actually hold a real, non-negligible balance
  // — an empty "Mutual Funds: 0" slice adds visual noise for no reason.
  const present = labels.map((l, i) => ({ l, v: values[i] })).filter(x => Math.abs(x.v) > 0.005);
  if (!present.length) return null;

  return (
    <Doughnut
      data={{
        labels: present.map(x => x.l),
        datasets: [{
          data: present.map(x => x.v),
          backgroundColor: present.map((_, i) => COLORS[i % COLORS.length]),
          borderColor: '#fff',
          borderWidth: 2,
        }],
      }}
      options={{
        responsive: true, maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: { position: 'right', labels: { font: { size: 10 }, boxWidth: 10, padding: 10 } },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const total = present.reduce((s, x) => s + x.v, 0);
                const v = ctx.raw as number;
                const pct = total > 0 ? ((v / total) * 100).toFixed(1) : '0.0';
                return `${ctx.label}: ${pct}%`;
              },
            },
          },
        },
      }}
    />
  );
}
