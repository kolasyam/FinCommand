'use client';

/**
 * 12-column drag/resize grid for "My Dashboard" — pure pointer events, no
 * drag-and-drop library, same algorithm as the reference dashboard
 * builder's own grid canvas: move clamps X into [0, cols-w] with Y
 * unbounded (the canvas just grows); resize clamps to a minimum 2 cols /
 * 3 rows and can't push past the right edge. `onChange` fires once per
 * gesture, on pointer-up, with the full widget array (only the dragged
 * widget's geometry replaced) — never continuously during the drag, to
 * avoid re-rendering (and re-resolving) every widget on every pixel of
 * movement. There is deliberately no collision avoidance (matching the
 * reference exactly) — widgets can be dropped on top of each other; that's
 * an accepted, known limitation for v1, not an oversight.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DashboardWidget } from '@/lib/financial/dashboard-builder-engine';

interface DragState {
  id: string;
  mode: 'move' | 'resize';
  startX: number;
  startY: number;
  origin: { x: number; y: number; w: number; h: number };
}
interface Ghost { x: number; y: number; w: number; h: number; }

export function GridCanvas({
  widgets, cols = 12, rowHeight = 40, editable = false,
  selectedId, onSelect, onChange, onDelete, onDuplicate, renderContent,
}: {
  widgets: DashboardWidget[];
  cols?: number;
  rowHeight?: number;
  editable?: boolean;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onChange?: (widgets: DashboardWidget[]) => void;
  onDelete?: (id: string) => void;
  onDuplicate?: (id: string) => void;
  /** Decouples layout mechanics (this component) from metric resolution/rendering — the caller supplies the widget's actual content. */
  renderContent: (widget: DashboardWidget) => React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);

  // "Latest" refs so the window-level pointer listeners (attached once per
  // drag gesture) always see current props/state without needing to be torn
  // down and re-attached on every intermediate pointermove.
  const widgetsRef = useRef(widgets); widgetsRef.current = widgets;
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const dragRef = useRef<DragState | null>(null);
  const ghostRef = useRef<Ghost | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 1200));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cw = width / cols;

  const handlePointerMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = Math.round((e.clientX - d.startX) / cw);
    const dy = Math.round((e.clientY - d.startY) / rowHeight);
    const next: Ghost = d.mode === 'move'
      ? {
          x: Math.max(0, Math.min(cols - d.origin.w, d.origin.x + dx)),
          y: Math.max(0, d.origin.y + dy),
          w: d.origin.w, h: d.origin.h,
        }
      : {
          x: d.origin.x, y: d.origin.y,
          w: Math.max(2, Math.min(cols - d.origin.x, d.origin.w + dx)),
          h: Math.max(3, d.origin.h + dy),
        };
    ghostRef.current = next;
    setGhost(next);
  }, [cw, rowHeight, cols]);

  const handlePointerUp = useCallback(() => {
    const d = dragRef.current;
    const g = ghostRef.current;
    if (d && g && onChangeRef.current) {
      onChangeRef.current(widgetsRef.current.map((w) =>
        w.id === d.id ? { ...w, gridX: g.x, gridY: g.y, gridW: g.w, gridH: g.h } : w
      ));
    }
    dragRef.current = null;
    ghostRef.current = null;
    setDrag(null);
    setGhost(null);
  }, []);

  useEffect(() => {
    if (!drag) return;
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [drag, handlePointerMove, handlePointerUp]);

  function start(e: React.PointerEvent, w: DashboardWidget, mode: 'move' | 'resize') {
    if (!editable) return;
    onSelect?.(w.id);
    const state: DragState = { id: w.id, mode, startX: e.clientX, startY: e.clientY, origin: { x: w.gridX, y: w.gridY, w: w.gridW, h: w.gridH } };
    const g: Ghost = { x: w.gridX, y: w.gridY, w: w.gridW, h: w.gridH };
    dragRef.current = state;
    ghostRef.current = g;
    setDrag(state);
    setGhost(g);
  }

  const rows = Math.max(12, ...widgets.map((w) => w.gridY + w.gridH)) + (editable ? 4 : 1);

  return (
    <div
      ref={containerRef}
      className={`dash-grid${editable ? ' editable' : ''}`}
      style={{
        position: 'relative',
        height: rows * rowHeight,
        backgroundImage: editable ? 'radial-gradient(circle, var(--border2) 1px, transparent 1px)' : undefined,
        backgroundSize: editable ? `${cw}px ${rowHeight}px` : undefined,
      }}
    >
      {widgets.length === 0 && (
        <div className="dash-grid-empty">
          {editable ? 'Add a widget from the panel to start building.' : 'This dashboard has no widgets yet.'}
        </div>
      )}
      {widgets.map((w) => {
        const isDragging = drag?.id === w.id;
        const pos = isDragging && ghost ? ghost : { x: w.gridX, y: w.gridY, w: w.gridW, h: w.gridH };
        return (
          <div
            key={w.id}
            data-widget-id={w.id}
            className={`dash-grid-item${editable ? ' editable' : ''}${selectedId === w.id ? ' selected' : ''}${isDragging ? ' dragging' : ''}`}
            style={{ left: pos.x * cw, top: pos.y * rowHeight, width: pos.w * cw, height: pos.h * rowHeight }}
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest('[data-no-drag]')) return;
              start(e, w, 'move');
            }}
          >
            {renderContent(w)}
            {editable && (
              <div className="dash-grid-toolbar" data-no-drag>
                <button type="button" title="Widget settings" onClick={() => onSelect?.(w.id)}>⚙</button>
                <button type="button" title="Duplicate" onClick={() => onDuplicate?.(w.id)}>⧉</button>
                <button type="button" title="Delete" onClick={() => onDelete?.(w.id)}>🗑</button>
              </div>
            )}
            {editable && (
              <div
                className="dash-grid-resize-handle"
                data-no-drag
                onPointerDown={(e) => { e.stopPropagation(); start(e, w, 'resize'); }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
