'use client';

/**
 * Scrolls to and briefly highlights a note card by its `note-card-${key}`
 * DOM id (`key` is the same `bs_${note_no}` / `pl_${note_no}` identity
 * NotesTab.tsx's own getNoteKey() / dashboard-builder-engine.ts's
 * noteUnionKey() both use). Shared by NotesTab.tsx's own Note Index table,
 * its cross-tab `pendingNoteKey` jump (from Balance Sheet / P&L Note
 * references), and the customized grid's `note_index` widget — a single
 * canonical implementation so the jump/highlight behavior can never drift
 * between the fixed zone and the customizable zone the way a duplicated
 * copy risks.
 */
export function jumpToNoteCard(key: string): void {
  const el = document.getElementById(`note-card-${key}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el.classList.remove('note-highlight');
  // Force a reflow so re-adding the class restarts the animation even if
  // the same note is jumped to twice in a row.
  void el.offsetWidth;
  el.classList.add('note-highlight');
}
