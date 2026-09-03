'use client';

import { useState, useEffect } from 'react';

interface IncorporationDateInputProps {
  value: string; // 'YYYY-MM-DD'
  onChange: (v: string) => void;
  max?: string; // 'YYYY-MM-DD' — bounds the Year input, mirrors the "not future" rule
  error?: boolean;
  theme?: 'light' | 'dark';
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function parseISO(v: string): { y: number; m: number; d: number } | null {
  if (!v) return null;
  const datePart = v.slice(0, 10);
  const [y, m, d] = datePart.split('-').map(Number);
  if (isNaN(y) || isNaN(m) || isNaN(d)) return null;
  return { y, m, d };
}

function isValidYMD(y: number, m: number, d: number): boolean {
  if (!y || !m || !d) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** Google Account "Birthday"-style split date entry: Month select + Day/Year number
 * inputs, each in its own outlined box with a label notched into the border line. */
export function IncorporationDateInput({ value, onChange, max, error, theme = 'light' }: IncorporationDateInputProps) {
  const [month, setMonth] = useState('');
  const [day, setDay] = useState('');
  const [year, setYear] = useState('');

  // Sync state if value changes externally
  useEffect(() => {
    const p = parseISO(value);
    if (p) {
      setMonth(String(p.m));
      setDay(String(p.d));
      setYear(String(p.y));
    } else {
      setMonth('');
      setDay('');
      setYear('');
    }
  }, [value]);

  const maxParsed = parseISO(max || '');
  const maxYear = maxParsed ? maxParsed.y : new Date().getFullYear();

  function emit(mm: string, dd: string, yy: string) {
    const m = Number(mm), d = Number(dd), y = Number(yy);
    if (mm && dd && yy.length === 4 && isValidYMD(y, m, d)) {
      onChange(`${yy}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    } else {
      onChange('');
    }
  }

  const isDark = theme === 'dark';
  const textColor = isDark ? '#e5e7eb' : 'var(--text, #111827)';
  const selectBg = isDark ? '#111827' : '#ffffff';

  const innerStyle: React.CSSProperties = {
    width: '100%', background: 'transparent', border: 'none', outline: 'none',
    color: textColor, fontSize: 13, padding: '14px 12px 9px', fontFamily: 'inherit',
  };

  return (
    <div style={{ display: 'flex', gap: 10 }}>
      <style>{`
        .doi-num::-webkit-outer-spin-button, .doi-num::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
        .doi-num { -moz-appearance: textfield; }
        .doi-select option { background: ${selectBg}; color: ${textColor}; }
      `}</style>

      <DateField label="Month" error={error} theme={theme} grow>
        <div style={{ position: 'relative' }}>
          <select
            className="doi-select"
            value={month}
            onChange={e => { setMonth(e.target.value); emit(e.target.value, day, year); }}
            style={{ ...innerStyle, appearance: 'none', WebkitAppearance: 'none', cursor: 'pointer', paddingRight: 26 }}
          >
            <option value="" disabled hidden />
            {MONTH_NAMES.map((mn, i) => (
              <option key={mn} value={i + 1}>{mn}</option>
            ))}
          </select>
          <svg
            width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round"
            style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: '#6b7280', pointerEvents: 'none' }}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </DateField>

      <DateField label="Day" error={error} theme={theme}>
        <input
          className="doi-num" type="number" inputMode="numeric" min={1} max={31} placeholder="DD"
          value={day}
          onChange={e => { const v = e.target.value.slice(0, 2); setDay(v); emit(month, v, year); }}
          style={innerStyle}
        />
      </DateField>

      <DateField label="Year" error={error} theme={theme}>
        <input
          className="doi-num" type="number" inputMode="numeric" min={1900} max={maxYear} placeholder="YYYY"
          value={year}
          onChange={e => { const v = e.target.value.slice(0, 4); setYear(v); emit(month, day, v); }}
          style={innerStyle}
        />
      </DateField>
    </div>
  );
}

function DateField({
  label, error, theme, grow, children,
}: { label: string; error?: boolean; theme: 'light' | 'dark'; grow?: boolean; children: React.ReactNode }) {
  const [focused, setFocused] = useState(false);
  const isDark = theme === 'dark';
  
  const stateColor = error
    ? '#d85a30'
    : focused
      ? (isDark ? '#185fa5' : 'var(--blue, #185fa5)')
      : (isDark ? 'rgba(255,255,255,.12)' : 'var(--border2, #d1d5db)');
      
  const bg = isDark ? 'rgba(255,255,255,.04)' : '#ffffff';
  const labelBg = isDark ? '#131b2e' : '#ffffff'; // Match parent card backgrounds
  const labelColor = error ? '#f5a582' : focused ? (isDark ? '#5b9fe0' : 'var(--blue, #185fa5)') : '#9ca3af';

  return (
    <div
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        position: 'relative', flex: grow ? 2 : 1,
        border: `1px solid ${stateColor}`, borderRadius: 8,
        background: bg,
        boxShadow: focused ? '0 0 0 3px rgba(24,95,165,.22)' : 'none',
        transition: 'border-color .12s ease, box-shadow .12s ease',
      }}
    >
      <label
        style={{
          position: 'absolute', top: -7, left: 10, padding: '0 5px', fontSize: 10, fontWeight: 500,
          letterSpacing: .3, color: labelColor,
          background: labelBg, borderRadius: 3, pointerEvents: 'none', whiteSpace: 'nowrap',
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}
