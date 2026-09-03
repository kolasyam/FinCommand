'use client';

/**
 * Shared helpers for the 3-Year comparison view used across all dashboard tabs.
 */

import type { ThreeYearEntry } from '@/lib/dashboard/types';

/**
 * Banner shown at the top of every 3-year tab when fewer than 3 years have data.
 * Shows nothing when all 3 years are present.
 */
export function ThreeYearBanner({ years }: { years: ThreeYearEntry[] }) {
  const withData = years.filter(y => !y.no_data).length;
  const totalSlots = 3;
  const missing = totalSlots - years.length + years.filter(y => y.no_data).length;
  if (missing <= 0) return null;

  const uploadCount = missing === 1 ? '1 more year' : `${missing} more years`;

  return (
    <div className="info-bar" style={{
      display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 14,
      background: 'rgba(55,138,221,.08)', border: '1px solid rgba(55,138,221,.22)',
    }}>
      <span style={{ fontSize: 16, lineHeight: 1 }}>ℹ️</span>
      <span style={{ fontSize: 12, lineHeight: 1.6 }}>
        <strong>{withData} of 3 year{withData !== 1 ? 's' : ''} of data available.</strong>
        {' '}Upload a Trial Balance for {uploadCount} to see the full 3-year comparison.
        Missing years are shown as{' '}
        <span style={{ fontWeight: 600, color: 'var(--text2)' }}>No Data</span> below.
      </span>
    </div>
  );
}

/** A "—" placeholder table cell for years that have no TB data. */
export function NoDataCol({ label, colSpan = 1 }: { label?: string; colSpan?: number }) {
  return (
    <td className="num" colSpan={colSpan} style={{
      textAlign: 'center', color: 'var(--text3)', fontStyle: 'italic', fontSize: 11,
    }}>
      {label || '—'}
    </td>
  );
}

/**
 * Standard 3-year column header row.
 * `particularHeader` — left-column label (e.g. "Particulars").
 * Shows "(No data)" suffix if year has no TB.
 */
export function ThreeYearHeader({
  years,
  particularHeader = 'Particulars',
}: {
  years: ThreeYearEntry[];
  particularHeader?: string;
}) {
  return (
    <thead>
      <tr>
        <th style={{ width: '40%' }}>{particularHeader}</th>
        {years.map(y => (
          <th key={y.financial_year.id} className="num" style={{ minWidth: 90 }}>
            {y.financial_year.short_label || y.financial_year.label}
            {y.no_data && (
              <div style={{ fontSize: 9, fontWeight: 400, color: 'var(--text3)' }}>(No data)</div>
            )}
          </th>
        ))}
        {/* Ghost columns for missing years so table always has 3 data cols */}
        {Array.from({ length: Math.max(0, 3 - years.length) }).map((_, i) => (
          <th key={`ghost-${i}`} className="num" style={{ minWidth: 90, color: 'var(--text3)', fontStyle: 'italic', fontSize: 10 }}>
            Upload TB
          </th>
        ))}
      </tr>
    </thead>
  );
}

/**
 * A single 3-year table row. `values` maps year index to a rendered string
 * (or null → "—"). `tones`, when provided, maps year index to a color class
 * ('up'/'dn'/'') derived from the underlying raw number via numTone() —
 * pass it for any row of real financial figures so negative values render
 * red and positive render green, matching every other financial table.
 * Omit `tones` for non-numeric/status rows (e.g. "✓ Yes" / "✗ No").
 * Ghost columns are appended for missing FY slots.
 */
export function ThreeYearRow({
  label,
  years,
  values,
  tones,
  bold,
  grand,
  indent,
}: {
  label: string;
  years: ThreeYearEntry[];
  values: (string | null)[];
  tones?: ('up' | 'dn' | '')[];
  bold?: boolean;
  grand?: boolean;
  indent?: boolean;
}) {
  const cls = grand ? 'grand-row' : bold ? 'tot-row' : undefined;
  const tdCls = bold || grand ? 'bold' : undefined;
  return (
    <tr className={cls}>
      <td className={`${indent ? 'ind1 ' : ''}${tdCls || ''}`}>{label}</td>
      {values.map((v, i) => {
        const toneCls = tones?.[i] || (v && v.includes('(') ? 'dn' : '');
        return (
          <td key={i} className={`num ${tdCls || ''} ${toneCls}`}>
            {v !== null ? v : <span style={{ color: 'var(--text3)', fontStyle: 'italic' }}>—</span>}
          </td>
        );
      })}
      {/* Ghost columns for missing FY slots */}
      {Array.from({ length: Math.max(0, 3 - years.length) }).map((_, i) => (
        <td key={`g${i}`} className="num" style={{ color: 'var(--text3)', fontStyle: 'italic' }}>—</td>
      ))}
    </tr>
  );
}
