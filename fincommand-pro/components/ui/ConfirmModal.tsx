'use client';

import { useEffect, useState } from 'react';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Premium replacement for window.confirm() — glassmorphic overlay, dark card,
 * pop/fade micro-animations on both open and close. Stays mounted briefly
 * after `open` flips false so the exit animation can play before unmount. */
export function ConfirmModal({
  open, title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  danger = true, busy = false, onConfirm, onCancel,
}: ConfirmModalProps) {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (mounted) {
      setClosing(true);
      const t = setTimeout(() => { setMounted(false); setClosing(false); }, 160);
      return () => clearTimeout(t);
    }
  }, [open, mounted]);

  useEffect(() => {
    if (!mounted) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onCancel(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mounted, onCancel]);

  if (!mounted) return null;

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(6,10,18,.55)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
        animation: `${closing ? 'cm-fade-out' : 'cm-fade-in'} .18s ease forwards`,
      }}
    >
      <style>{`
        @keyframes cm-fade-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes cm-fade-out { from { opacity: 1; } to { opacity: 0; } }
        @keyframes cm-pop-in { from { opacity: 0; transform: translateY(8px) scale(.96); } to { opacity: 1; transform: translateY(0) scale(1); } }
        @keyframes cm-pop-out { from { opacity: 1; transform: translateY(0) scale(1); } to { opacity: 0; transform: translateY(6px) scale(.97); } }
        .cm-cancel:hover { background: rgba(255,255,255,.08) !important; }
        .cm-confirm:hover:not(:disabled) { filter: brightness(1.1); }
        .cm-confirm:disabled { opacity: .6; cursor: not-allowed; }
      `}</style>
      <div
        onClick={e => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="cm-title"
        style={{
          width: 360, maxWidth: 'calc(100vw - 32px)', background: '#0f1826',
          border: '1px solid rgba(255,255,255,.1)', borderRadius: 14, padding: 24,
          boxShadow: '0 24px 60px rgba(0,0,0,.5)',
          animation: `${closing ? 'cm-pop-out' : 'cm-pop-in'} .18s ease forwards`,
        }}
      >
        <div id="cm-title" style={{ fontSize: 16, fontWeight: 700, color: '#fff', marginBottom: 8 }}>{title}</div>
        <div style={{ fontSize: 13, color: '#9ca3af', lineHeight: 1.5, marginBottom: 22 }}>{message}</div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            type="button" className="cm-cancel" onClick={onCancel}
            style={{
              padding: '9px 18px', borderRadius: 8, background: 'transparent', border: '1px solid rgba(255,255,255,.15)',
              color: '#e5e7eb', fontSize: 13, cursor: 'pointer', transition: 'background .12s ease',
            }}
          >
            {cancelLabel}
          </button>
          <button
            type="button" className="cm-confirm" disabled={busy} onClick={onConfirm}
            style={{
              padding: '9px 18px', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer',
              color: '#fff', background: danger ? '#d85a30' : '#185fa5', transition: 'filter .12s ease',
            }}
          >
            {busy ? 'Please wait…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
