'use client';

import React, { createContext, useCallback, useContext, useRef, useState } from 'react';

interface ToastState { message: string; visible: boolean }
const ToastCtx = createContext<((msg: string) => void) | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ToastState>({ message: '', visible: false });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toast = useCallback((message: string) => {
    if (timer.current) clearTimeout(timer.current);
    setState({ message, visible: true });
    timer.current = setTimeout(() => setState(s => ({ ...s, visible: false })), 2800);
  }, []);

  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className={`toast${state.visible ? ' show' : ''}`}>{state.message}</div>
    </ToastCtx.Provider>
  );
}

export function useToast(): (msg: string) => void {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
