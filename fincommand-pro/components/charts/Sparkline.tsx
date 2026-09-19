'use client';

/**
 * Minimal inline trend line — no axes, no legend, no tooltip — for showing a
 * real monthly shape next to a single figure (e.g. a Notes to Accounts P&L
 * note's real `AggregatedNote.monthly`, computed by aggregateByNote() but,
 * before this component, never actually displayed anywhere). Deliberately
 * tiny and dependency-light: same Chart.js setup as every other chart here,
 * just stripped down to the shape alone.
 */
import { useEffect } from 'react';
import { Line } from 'react-chartjs-2';
import { ensureChartsRegistered } from '@/lib/charts/register';

export function Sparkline({ values, color = '#378ADD', height = 26, width = 84 }: { values: number[]; color?: string; height?: number; width?: number }) {
  useEffect(() => { ensureChartsRegistered(); }, []);
  const isFlat = values.every((v) => v === 0);
  return (
    <div style={{ height, width, position: 'relative', flexShrink: 0 }}>
      <Line
        data={{
          labels: values.map((_, i) => String(i)),
          datasets: [{
            data: values,
            borderColor: isFlat ? '#9ca3af' : color,
            backgroundColor: `${color}22`,
            borderWidth: 1.5, tension: 0.3, pointRadius: 0, fill: true,
          }],
        }}
        options={{
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { enabled: false } },
          scales: { x: { display: false }, y: { display: false } },
        }}
      />
    </div>
  );
}
