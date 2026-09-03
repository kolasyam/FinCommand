'use client';

import { useEffect, useState } from 'react';
import { useDashboard } from '@/lib/dashboard/DashboardContext';
import { useToast } from '@/lib/dashboard/ToastContext';
import { apiFetch, ApiClientError } from '@/lib/dashboard/api-client';
import { DatePicker } from '@/components/ui/DatePicker';
import type { FyLike } from '@/lib/dashboard/types';

interface AddFyModalProps {
  open: boolean;
  onClose: () => void;
}

type YearType = 'FY' | 'CY';

const PANEL_BG = '#0f1826'; // solid equivalent of rgba(15,24,38,.95), used to mask notched labels

function parseISO(v: string): { y: number; m: number; d: number } | null {
  if (!v) return null;
  const clean = v.slice(0, 10);
  const [y, m, d] = clean.split('-').map(Number);
  if (!y || !m || !d) return null;
  return { y, m, d };
}
function cleanYMD(v: string): string {
  return (v || '').slice(0, 10);
}
function toISO(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function addDaysISO(v: string, days: number): string {
  const p = parseISO(v);
  if (!p) return '';
  const dt = new Date(p.y, p.m - 1, p.d);
  dt.setDate(dt.getDate() + days);
  return toISO(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}
function addYearsMinusDay(v: string): string {
  const p = parseISO(v);
  if (!p) return '';
  const dt = new Date(p.y + 1, p.m - 1, p.d);
  dt.setDate(dt.getDate() - 1);
  return toISO(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}
function suggestLabel(v: string, yt: YearType): string {
  const p = parseISO(v);
  if (!p) return '';
  if (yt === 'CY') return `CY ${p.y}`;
  return `FY ${p.y}-${String((p.y + 1) % 100).padStart(2, '0')}`;
}
function suggestShortLabel(v: string, yt: YearType): string {
  const p = parseISO(v);
  if (!p) return '';
  if (yt === 'CY') return `CY${String(p.y % 100).padStart(2, '0')}`;
  return `FY${String((p.y + 1) % 100).padStart(2, '0')}`;
}
function defaultStartDate(fyList: FyLike[], yt: YearType): string {
  if (fyList.length) {
    const latest = [...fyList].sort((a, b) => (cleanYMD(a.end_date) < cleanYMD(b.end_date) ? 1 : -1))[0];
    return addDaysISO(cleanYMD(latest.end_date), 1);
  }
  const y = new Date().getFullYear();
  return yt === 'CY' ? toISO(y, 1, 1) : toISO(y, 4, 1);
}
function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const aS = cleanYMD(aStart);
  const aE = cleanYMD(aEnd);
  const bS = cleanYMD(bStart);
  const bE = cleanYMD(bEnd);
  return aS <= bE && aE >= bS;
}

const inputInnerStyle: React.CSSProperties = {
  width: '100%', background: 'transparent', border: 'none', outline: 'none',
  color: '#e5e7eb', fontSize: 13, padding: '14px 12px 9px', fontFamily: 'inherit',
};

/** Notched-border field (used for plain text inputs) — border + background + a
 * floating label that sits directly on the border line, Google Account style. */
function Field({ label, error, children }: { label: string; error?: boolean; children: React.ReactNode }) {
  const [focused, setFocused] = useState(false);
  const stateColor = error ? '#d85a30' : focused ? '#185fa5' : 'rgba(255,255,255,.14)';
  return (
    <div
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        position: 'relative', border: `1px solid ${stateColor}`, borderRadius: 8,
        background: 'rgba(255,255,255,.04)',
        boxShadow: focused ? '0 0 0 3px rgba(24,95,165,.22)' : 'none',
        transition: 'border-color .12s ease, box-shadow .12s ease',
      }}
    >
      <NotchLabel text={label} color={error ? '#f5a582' : focused ? '#5b9fe0' : '#9ca3af'} />
      {children}
    </div>
  );
}

/** Label-only overlay for children that already render their own border
 * (DatePicker, the Year Type toggle) — avoids a double-border look. */
function OverlayField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ position: 'relative' }}>
      <NotchLabel text={label} color="#9ca3af" />
      {children}
    </div>
  );
}

function NotchLabel({ text, color }: { text: string; color: string }) {
  return (
    <label
      style={{
        position: 'absolute', top: -7, left: 10, padding: '0 5px', fontSize: 10, fontWeight: 500,
        letterSpacing: .3, color, background: PANEL_BG, borderRadius: 3, pointerEvents: 'none', zIndex: 1,
      }}
    >
      {text}
    </label>
  );
}

export function AddFyModal({ open, onClose }: AddFyModalProps) {
  const { fyList, loadFyList } = useDashboard();
  const toast = useToast();

  const [yearType, setYearType] = useState<YearType>('FY');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [label, setLabel] = useState('');
  const [shortLabel, setShortLabel] = useState('');
  const [endTouched, setEndTouched] = useState(false);
  const [labelTouched, setLabelTouched] = useState(false);
  const [shortTouched, setShortTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Re-seed smart defaults every time the modal opens.
  useEffect(() => {
    if (!open) return;
    const yt: YearType = 'FY';
    const sd = defaultStartDate(fyList, yt);
    const ed = addYearsMinusDay(sd);
    setYearType(yt);
    setStartDate(sd);
    setEndDate(ed);
    setLabel(suggestLabel(sd, yt));
    setShortLabel(suggestShortLabel(sd, yt));
    setEndTouched(false);
    setLabelTouched(false);
    setShortTouched(false);
    setError(null);
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  function applyStartDate(v: string) {
    setStartDate(v);
    if (!endTouched) setEndDate(addYearsMinusDay(v));
    if (!labelTouched) setLabel(suggestLabel(v, yearType));
    if (!shortTouched) setShortLabel(suggestShortLabel(v, yearType));
  }

  function applyYearType(yt: YearType) {
    setYearType(yt);
    if (!endTouched) setEndDate(addYearsMinusDay(startDate));
    if (!labelTouched) setLabel(suggestLabel(startDate, yt));
    if (!shortTouched) setShortLabel(suggestShortLabel(startDate, yt));
  }

  function validate(): string | null {
    if (!startDate || !endDate) return 'Select both a start and end date.';
    if (endDate <= startDate) return 'End date must be after the start date.';
    if (!label.trim()) return 'A label is required.';
    
    const overlappingFy = fyList.find(f => rangesOverlap(startDate, endDate, f.start_date, f.end_date));
    if (overlappingFy) {
      if (endDate === overlappingFy.start_date) {
        return `End date ${endDate} touches ${overlappingFy.label} start date (${overlappingFy.start_date}). Set end date to 1 day earlier.`;
      }
      return `This date range overlaps existing year ${overlappingFy.label} (${overlappingFy.start_date} to ${overlappingFy.end_date}).`;
    }
    return null;
  }

  async function submit() {
    const v = validate();
    if (v) { setError(v); return; }
    setBusy(true);
    setError(null);
    try {
      const created = await apiFetch<FyLike>('/fy', {
        method: 'POST',
        body: JSON.stringify({
          label: label.trim(),
          short_label: shortLabel.trim() || label.trim(),
          start_date: startDate,
          end_date: endDate,
          year_type: yearType,
        }),
      });
      await loadFyList();
      toast(`${created.label} added`);
      onClose();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Failed to create financial year');
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(6,10,18,.55)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
        animation: 'afy-fade-in .18s ease forwards',
      }}
    >
      <style>{`
        @keyframes afy-fade-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes afy-pop-in { from { opacity: 0; transform: translateY(8px) scale(.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
        .afy-btn { transition: filter .12s ease, background .12s ease; }
        .afy-btn:hover:not(:disabled) { filter: brightness(1.08); }
        .afy-btn:disabled { opacity: .55; cursor: not-allowed; }
      `}</style>
      <div
        onClick={e => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-labelledby="afy-title"
        style={{
          width: 420, maxWidth: 'calc(100vw - 32px)', background: 'rgba(15,24,38,.95)',
          border: '1px solid rgba(255,255,255,.1)', borderRadius: 14, padding: 26,
          boxShadow: '0 24px 60px rgba(0,0,0,.5)', animation: 'afy-pop-in .18s ease forwards',
        }}
      >
        <div id="afy-title" style={{ fontSize: 16, fontWeight: 700, color: '#fff', marginBottom: 4 }}>Add Financial Year</div>
        <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 20 }}>
          Dates default to the day after your latest year ends — adjust as needed.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <OverlayField label="Year Type">
            <div style={{ display: 'flex', border: '1px solid rgba(255,255,255,.14)', borderRadius: 8, overflow: 'hidden' }}>
              {(['FY', 'CY'] as YearType[]).map(t => (
                <button
                  key={t} type="button" className="afy-btn" onClick={() => applyYearType(t)}
                  style={{
                    flex: 1, padding: '11px 0', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                    background: yearType === t ? '#185fa5' : 'transparent', color: yearType === t ? '#fff' : '#9ca3af',
                  }}
                >
                  {t === 'FY' ? 'Fiscal Year' : 'Calendar Year'}
                </button>
              ))}
            </div>
          </OverlayField>

          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <OverlayField label="Start Date">
                <DatePicker value={startDate} onChange={applyStartDate} placeholder="Select start date" />
              </OverlayField>
            </div>
            <div style={{ flex: 1 }}>
              <OverlayField label="End Date">
                <DatePicker value={endDate} onChange={v => { setEndDate(v); setEndTouched(true); }} placeholder="Select end date" />
              </OverlayField>
            </div>
          </div>

          <Field label="Label">
            <input
              value={label}
              onChange={e => { setLabel(e.target.value); setLabelTouched(true); }}
              placeholder="FY 2025-26" style={inputInnerStyle}
            />
          </Field>

          <Field label="Short Label">
            <input
              value={shortLabel}
              onChange={e => { setShortLabel(e.target.value); setShortTouched(true); }}
              placeholder="FY26" style={inputInnerStyle}
            />
          </Field>

          {error && (
            <div style={{ background: 'rgba(217,90,48,.12)', color: '#f5a582', padding: '10px 12px', borderRadius: 8, fontSize: 12, borderLeft: '3px solid #d85a30' }}>
              {error}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 22 }}>
          <button
            type="button" className="afy-btn" onClick={onClose}
            style={{ padding: '9px 18px', borderRadius: 8, background: 'transparent', border: '1px solid rgba(255,255,255,.15)', color: '#e5e7eb', fontSize: 13, cursor: 'pointer' }}
          >
            Cancel
          </button>
          <button
            type="button" className="afy-btn" disabled={busy} onClick={submit}
            style={{ padding: '9px 18px', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: '#fff', background: '#185fa5' }}
          >
            {busy ? 'Creating…' : 'Create Financial Year'}
          </button>
        </div>
      </div>
    </div>
  );
}
