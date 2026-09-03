'use client';

import { useEffect, useRef, useState } from 'react';

interface DatePickerProps {
  value: string; // 'YYYY-MM-DD'
  onChange: (v: string) => void;
  max?: string; // 'YYYY-MM-DD' — dates after this are disabled/unselectable
  placeholder?: string;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function toISO(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function parseISO(v: string): { y: number; m: number; d: number } | null {
  if (!v) return null;
  const [y, m, d] = v.split('-').map(Number);
  if (!y || !m || !d) return null;
  return { y, m: m - 1, d };
}
function formatDisplay(v: string): string {
  const p = parseISO(v);
  if (!p) return '';
  return `${String(p.d).padStart(2, '0')} ${MONTH_NAMES[p.m].slice(0, 3)} ${p.y}`;
}

/** Custom-styled calendar popup — replaces the browser-default date input so
 * the "not in the future" constraint reads as visibly disabled days rather
 * than a silent native validation message. */
export function DatePicker({ value, onChange, max, placeholder = 'Select date' }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const parsed = parseISO(value);
  const maxParsed = parseISO(max || '');
  const today = new Date();
  const [viewY, setViewY] = useState(parsed?.y ?? today.getFullYear());
  const [viewM, setViewM] = useState(parsed?.m ?? today.getMonth());
  const [viewMode, setViewMode] = useState<'days' | 'months' | 'years'>('days');
  const [yearPageStart, setYearPageStart] = useState(Math.floor((parsed?.y ?? today.getFullYear()) / 12) * 12);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setViewMode('days');
      }
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        setViewMode('days');
      }
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setViewMode('days');
      setYearPageStart(Math.floor(viewY / 12) * 12);
    }
  }, [open, viewY]);

  function isDisabled(y: number, m: number, d: number): boolean {
    if (!maxParsed) return false;
    return new Date(y, m, d).getTime() > new Date(maxParsed.y, maxParsed.m, maxParsed.d).getTime();
  }
  function canGoNext(): boolean {
    if (!maxParsed) return true;
    return viewY < maxParsed.y || (viewY === maxParsed.y && viewM < maxParsed.m);
  }
  function goMonth(delta: number) {
    let m = viewM + delta, y = viewY;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    setViewM(m); setViewY(y);
  }

  const firstDow = new Date(viewY, viewM, 1).getDay();
  const daysInMonth = new Date(viewY, viewM + 1, 0).getDate();
  const cells: (number | null)[] = [...Array(firstDow).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', padding: '11px 13px', borderRadius: 8, fontSize: 13,
          background: 'rgba(255,255,255,.04)', border: `1px solid ${open ? '#185fa5' : 'rgba(255,255,255,.12)'}`,
          color: value ? '#e5e7eb' : '#6b7280', outline: 'none', cursor: 'pointer', fontFamily: 'inherit',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          boxShadow: open ? '0 0 0 3px rgba(24,95,165,.25)' : 'none', transition: 'border-color .12s ease, box-shadow .12s ease',
        }}
      >
        <span>{value ? formatDisplay(value) : placeholder}</span>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: '#6b7280', flexShrink: 0 }}>
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 60, width: 264,
          background: '#0f1826', border: '1px solid rgba(255,255,255,.12)', borderRadius: 10,
          boxShadow: '0 16px 40px rgba(0,0,0,.4)', padding: 12,
        }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <button
              type="button"
              onClick={() => {
                if (viewMode === 'days') goMonth(-1);
                else if (viewMode === 'years') setYearPageStart(y => y - 12);
              }}
              disabled={viewMode === 'months'}
              style={{ ...navBtnStyle, opacity: viewMode === 'months' ? 0.3 : 1, cursor: viewMode === 'months' ? 'default' : 'pointer' }}
            >
              ‹
            </button>
            
            <div style={{ fontSize: 12, fontWeight: 600, color: '#e5e7eb', display: 'flex', gap: 4 }}>
              {viewMode === 'days' ? (
                <>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={() => setViewMode('months')}
                    onKeyDown={e => e.key === 'Enter' && setViewMode('months')}
                    style={{ cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'rgba(255,255,255,0.3)' }}
                  >
                    {MONTH_NAMES[viewM]}
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      setViewMode('years');
                      setYearPageStart(Math.floor(viewY / 12) * 12);
                    }}
                    onKeyDown={e => e.key === 'Enter' && setViewMode('years')}
                    style={{ cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'rgba(255,255,255,0.3)' }}
                  >
                    {viewY}
                  </span>
                </>
              ) : viewMode === 'months' ? (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={() => setViewMode('days')}
                  onKeyDown={e => e.key === 'Enter' && setViewMode('days')}
                  style={{ cursor: 'pointer', color: '#185fa5' }}
                >
                  Select Month
                </span>
              ) : (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={() => setViewMode('days')}
                  onKeyDown={e => e.key === 'Enter' && setViewMode('days')}
                  style={{ cursor: 'pointer', color: '#185fa5' }}
                >
                  {yearPageStart} - {yearPageStart + 11}
                </span>
              )}
            </div>

            <button
              type="button"
              onClick={() => {
                if (viewMode === 'days') {
                  if (canGoNext()) goMonth(1);
                } else if (viewMode === 'years') {
                  setYearPageStart(y => y + 12);
                }
              }}
              disabled={viewMode === 'months' || (viewMode === 'days' && !canGoNext())}
              style={{
                ...navBtnStyle,
                opacity: (viewMode === 'months' || (viewMode === 'days' && !canGoNext())) ? 0.3 : 1,
                cursor: (viewMode === 'months' || (viewMode === 'days' && !canGoNext())) ? 'not-allowed' : 'pointer'
              }}
            >
              ›
            </button>
          </div>

          {/* Days View */}
          {viewMode === 'days' && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 2, marginBottom: 4 }}>
                {DOW.map((d, i) => <div key={i} style={{ fontSize: 9, textAlign: 'center', color: '#6b7280', padding: '2px 0' }}>{d}</div>)}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 2 }}>
                {cells.map((d, i) => {
                  if (d === null) return <div key={i} />;
                  const disabled = isDisabled(viewY, viewM, d);
                  const isSel = !!parsed && parsed.y === viewY && parsed.m === viewM && parsed.d === d;
                  const isToday = viewY === today.getFullYear() && viewM === today.getMonth() && d === today.getDate();
                  return (
                    <button
                      key={i} type="button" disabled={disabled}
                      onClick={() => { onChange(toISO(viewY, viewM, d)); setOpen(false); }}
                      style={{
                        width: '100%', aspectRatio: '1', border: 'none', borderRadius: 6, fontSize: 11,
                        cursor: disabled ? 'not-allowed' : 'pointer',
                        background: isSel ? '#185fa5' : 'transparent',
                        color: disabled ? '#3f4757' : isSel ? '#fff' : '#e5e7eb',
                        outline: isToday && !isSel ? '1px solid rgba(93,202,165,.5)' : 'none',
                        fontWeight: isSel ? 700 : 400,
                      }}
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {/* Months View */}
          {viewMode === 'months' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, padding: '4px 0' }}>
              {MONTH_NAMES.map((m, idx) => {
                const isSel = viewM === idx;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      setViewM(idx);
                      setViewMode('days');
                    }}
                    style={{
                      padding: '8px 4px',
                      border: 'none',
                      borderRadius: 6,
                      fontSize: 11,
                      cursor: 'pointer',
                      background: isSel ? '#185fa5' : 'rgba(255,255,255,.04)',
                      color: '#e5e7eb',
                      fontWeight: isSel ? 700 : 400,
                    }}
                  >
                    {m.slice(0, 3)}
                  </button>
                );
              })}
            </div>
          )}

          {/* Years View */}
          {viewMode === 'years' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, padding: '4px 0' }}>
              {Array.from({ length: 12 }, (_, i) => yearPageStart + i).map(y => {
                const isSel = viewY === y;
                return (
                  <button
                    key={y}
                    type="button"
                    onClick={() => {
                      setViewY(y);
                      setViewMode('days');
                    }}
                    style={{
                      padding: '8px 4px',
                      border: 'none',
                      borderRadius: 6,
                      fontSize: 11,
                      cursor: 'pointer',
                      background: isSel ? '#185fa5' : 'rgba(255,255,255,.04)',
                      color: '#e5e7eb',
                      fontWeight: isSel ? 700 : 400,
                    }}
                  >
                    {y}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const navBtnStyle: React.CSSProperties = {
  width: 24, height: 24, borderRadius: 6, border: 'none', background: 'rgba(255,255,255,.06)',
  color: '#e5e7eb', fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
};
