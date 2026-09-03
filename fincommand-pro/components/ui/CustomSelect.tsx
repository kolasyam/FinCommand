'use client';

import { useEffect, useRef, useState } from 'react';

export interface SelectOption { value: string; label: string }

interface CustomSelectProps {
  options: SelectOption[];
  value: string;
  onChange: (v: string) => void;
  variant?: 'dark' | 'light';
  placeholder?: string;
  id?: string;
}

const THEMES = {
  dark: {
    bg: 'rgba(255,255,255,.04)', border: 'rgba(255,255,255,.12)', text: '#e5e7eb',
    panelBg: '#0f1826', panelBorder: 'rgba(255,255,255,.12)',
    optionHover: 'rgba(255,255,255,.06)', accent: '#5b9fe0', accentBg: 'rgba(24,95,165,.16)',
    muted: '#6b7280', ring: 'rgba(24,95,165,.25)',
  },
  light: {
    bg: 'var(--bg)', border: 'var(--border2)', text: 'var(--text)',
    panelBg: 'var(--bg)', panelBorder: 'var(--border)',
    optionHover: 'var(--bg2)', accent: 'var(--blue)', accentBg: 'var(--blue-l)',
    muted: 'var(--text3)', ring: 'rgba(24,95,165,.15)',
  },
} as const;

/** Custom-styled listbox replacing the browser-default <select> — high-contrast selection state, checkmark on the active option, themeable for both the dark onboarding flow and the light dashboard chrome. */
export function CustomSelect({ options, value, onChange, variant = 'dark', placeholder = 'Select…', id }: CustomSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const t = THEMES[variant];
  const selected = options.find(o => o.value === value);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <div ref={ref} id={id} style={{ position: 'relative', fontSize: 13 }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          padding: '11px 13px', borderRadius: 8, background: t.bg, border: `1px solid ${open ? t.accent : t.border}`,
          color: t.text, cursor: 'pointer', fontSize: 13, textAlign: 'left', fontFamily: 'inherit',
          boxShadow: open ? `0 0 0 3px ${t.ring}` : 'none',
          transition: 'border-color .12s ease, box-shadow .12s ease',
        }}
      >
        <span style={{ color: selected ? t.text : t.muted }}>{selected ? selected.label : placeholder}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s ease', flexShrink: 0, color: t.muted }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, zIndex: 50,
            background: t.panelBg, border: `1px solid ${t.panelBorder}`, borderRadius: 8,
            boxShadow: '0 12px 32px rgba(0,0,0,.35)', overflow: 'hidden', padding: 4, maxHeight: 260, overflowY: 'auto',
          }}
        >
          {options.map(opt => {
            const isSel = opt.value === value;
            return (
              <div
                key={opt.value}
                role="option"
                aria-selected={isSel}
                onClick={() => { onChange(opt.value); setOpen(false); }}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                  padding: '9px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12,
                  color: isSel ? t.accent : t.text, background: isSel ? t.accentBg : 'transparent',
                  fontWeight: isSel ? 600 : 400, transition: 'background .1s ease',
                }}
                onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = t.optionHover; }}
                onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = 'transparent'; }}
              >
                {opt.label}
                {isSel && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
