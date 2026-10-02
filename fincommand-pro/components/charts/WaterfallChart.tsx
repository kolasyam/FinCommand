'use client';

/**
 * Native, live floating-bar waterfall/bridge — same construction as the
 * bespoke PDF exports' own native waterfalls (lib/exports/pl-pdf.ts's
 * drawProfitWaterfall(), lib/exports/cashflow-pdf.ts's drawCashBridge()),
 * which previously only existed on download. Chart.js renders a floating bar
 * natively when a dataset's data point is a [min,max] tuple instead of a
 * single number — no plugin needed. Generic over both use cases: P&L's
 * Revenue-to-PAT profit bridge and Cash Flow's Opening-to-Closing cash
 * bridge both just supply a different `steps` list.
 */
import { useEffect } from 'react';
import { Bar } from 'react-chartjs-2';
import { ensureChartsRegistered } from '@/lib/client/chart-register';
import { fl, formatChg, type DisplayUnit } from '@/lib/utils/format';

export interface WaterfallStep {
  label: string;
  /** For a total step: the real cumulative figure itself (e.g. Revenue, PAT, Opening/Closing Cash). For a delta step: the real signed change it applies to the running total (already negative for a deduction/outflow). */
  value: number;
  isTotal?: boolean;
}

export function WaterfallChart({ steps, unit = 'Lakhs' }: { steps: WaterfallStep[]; unit?: DisplayUnit }) {
  useEffect(() => { ensureChartsRegistered(); }, []);

  let running = 0;
  const ranges: [number, number][] = [];
  const colors: string[] = [];
  const deltas: number[] = [];
  steps.forEach((s) => {
    if (s.isTotal) {
      ranges.push([0, s.value]);
      colors.push('#1E3A8A');
      deltas.push(s.value);
      running = s.value;
    } else {
      const from = running;
      const to = running + s.value;
      ranges.push([Math.min(from, to), Math.max(from, to)]);
      colors.push(s.value < 0 ? '#D85A30' : '#1D9E75');
      deltas.push(s.value);
      running = to;
    }
  });

  return (
    <Bar
      data={{
        labels: steps.map((s) => s.label),
        datasets: [{ data: ranges, backgroundColor: colors, borderRadius: 3 }],
      }}
      options={{
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const i = ctx.dataIndex;
                return steps[i]?.isTotal ? fl(deltas[i], 2, unit) : formatChg(deltas[i], 2, unit);
              },
            },
          },
        },
        scales: {
          y: { ticks: { font: { size: 10 }, callback: (v) => fl(Number(v), 0, unit) }, grid: { color: 'rgba(128,128,128,0.07)' } },
          x: { ticks: { font: { size: 9 }, maxRotation: 40 }, grid: { display: false } },
        },
      }}
    />
  );
}
