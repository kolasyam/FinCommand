'use client';

import { useEffect, useState } from 'react';
import { useDashboard } from '@/lib/client/DashboardContext';
import { useToast } from '@/lib/client/ToastContext';
import { apiFetch, ApiClientError } from '@/lib/client/api-client';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Kpi } from '../Kpi';
import { DownloadBar } from '../DownloadBar';
import { fn, numTone, kpiTone, signedPct, getFyLabel, getFyShortLabel, getUnitHeader, unitSuffix, formatChg, type DisplayUnit, type CurrencyCode } from '@/lib/utils/format';
import { getCurrencyMeta } from '@/lib/services/currency';
import type { AggregatedNote } from '@/lib/financial/tb-engine';
import { NOTE_CATALOG, isBSSection } from '@/lib/financial/note-catalog';
import { ThreeYearBanner } from '../ThreeYearFrame';
import { Sparkline } from '@/components/charts/Sparkline';
import { jumpToNoteCard } from '@/lib/utils/note-navigation';
import { CustomizableTabPanel } from './dashboard-builder/CustomizableTabPanel';
import { NOTES_DEFAULT_WIDGETS } from '@/lib/dashboard-builder/default-layout';

// Mirrors ROLE_SETS.canWrite in lib/auth/permissions.ts (server-only — pulls
// in DB/Next.js server code, so not safe to import into a client
// component). The server route is the actual authority and re-checks this
// itself; this copy only decides whether to show the drag affordance at
// all, so a stale copy would just mean an extra denied request, never a
// bypassed check.
const CAN_RECLASSIFY_ROLES = ['admin', 'cfo', 'manager'];

/** What's carried from onDragStart through the browser's native drag-and-drop to whichever note card the ledger is dropped on. */
interface DragPayload {
  ledgerId: string;
  ledgerName: string;
  sourceNoteNo: number;
  sourceNoteName: string;
}

interface PendingReclassify extends DragPayload {
  targetNoteNo: number;
  targetSection: string;
  targetNoteName: string;
}

interface SingleNoteCardProps {
  currNote?: AggregatedNote;
  prevNote?: AggregatedNote;
  noteNo: number;
  /** `bs_${note_no}` or `pl_${note_no}` — this note's identity within the combined BS+P&L note list, used as this card's scroll-target DOM id so Balance Sheet / P&L note references can jump straight to it. */
  noteKey: string;
  financialYearLabel: string;
  prevYearLabel?: string;
  compare: boolean;
  unit: DisplayUnit;
  currency: CurrencyCode;
  canReclassify: boolean;
  onRequestReclassify: (p: PendingReclassify) => void;
}

function SingleNoteCard({
  currNote,
  prevNote,
  noteNo,
  noteKey,
  financialYearLabel,
  prevYearLabel,
  compare,
  unit,
  currency,
  canReclassify,
  onRequestReclassify,
}: SingleNoteCardProps) {
  const domId = `note-card-${noteKey}`;
  const noteName = currNote?.note_name || prevNote?.note_name || `Note ${noteNo}`;
  const section = currNote?.section || prevNote?.section || '';
  const cTotal = currNote?.total ?? 0;
  const pTotal = prevNote?.total ?? 0;
  const totChg = cTotal - pTotal;
  const sfx = unitSuffix(unit);
  const symbol = getCurrencyMeta(currency).symbol;
  // Real, already-computed by aggregateByNote() for every Income/Expense
  // note (Notes 20-26) — full 12-month movement, currency-converted along
  // with everything else — but never actually rendered anywhere before this.
  // Balance-Sheet-section notes carry an all-zero `monthly` by construction
  // (a point-in-time balance has no "this month's movement" the same way),
  // so the sparkline is only shown where it reflects something real.
  const monthlyTrend = !isBSSection(section) && currNote?.monthly && currNote.monthly.some((m) => m !== 0) ? currNote.monthly : null;
  const v = (n: number) => fn(n, 2, unit);
  const vChg = (n: number) => formatChg(n, 2, unit);
  const [dragOver, setDragOver] = useState(false);

  function handleDragStart(e: React.DragEvent, payload: DragPayload) {
    e.dataTransfer.setData('application/json', JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'move';
  }

  function handleDragOver(e: React.DragEvent) {
    if (!canReclassify) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOver(true);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (!canReclassify) return;
    let payload: DragPayload;
    try {
      payload = JSON.parse(e.dataTransfer.getData('application/json'));
    } catch {
      return;
    }
    if (payload.sourceNoteNo === noteNo && (currNote?.section || prevNote?.section) === section) return; // dropped on its own note — no-op
    onRequestReclassify({ ...payload, targetNoteNo: noteNo, targetSection: section, targetNoteName: noteName });
  }

  const dropProps = canReclassify ? {
    onDragOver: handleDragOver,
    onDragLeave: () => setDragOver(false),
    onDrop: handleDrop,
  } : {};

  // Single year view (no comparison)
  if (!compare || !prevYearLabel) {
    const ledgers = currNote?.ledgers || [];
    return (
      <div className={`note-block${dragOver ? ' note-drop-target' : ''}`} id={domId} {...dropProps}>
        <div className="note-hdr" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <div>
            <span className="nn">Note {noteNo}</span>
            <span className="nb">{noteName}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {monthlyTrend && <Sparkline values={monthlyTrend} color={numTone(cTotal) === 'dn' ? '#D85A30' : '#378ADD'} />}
            <span className="num bold">{symbol}{v(cTotal)}{sfx}</span>
          </div>
        </div>
        <table className="fc-table">
          <thead>
            <tr>
              <th>Ledger</th>
              <th className="num">Amount ({getUnitHeader(unit, currency)})</th>
            </tr>
          </thead>
          <tbody>
            {ledgers.map((l, i) => (
              <tr
                key={i}
                draggable={canReclassify && !!l.id}
                onDragStart={e => handleDragStart(e, { ledgerId: l.id as string, ledgerName: l.ledger_name, sourceNoteNo: noteNo, sourceNoteName: noteName })}
                className={canReclassify && l.id ? 'draggable-row' : undefined}
                title={canReclassify && l.id ? 'Drag onto another note to reclassify this ledger' : undefined}
              >
                <td className="ind1">{l.ledger_name}</td>
                <td className="num">{v(l.net)}</td>
              </tr>
            ))}
            <tr className="tot-row">
              <td className="bold">Total</td>
              <td className="num bold">{v(cTotal)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  }

  // Prior year comparison view
  const currL = currNote?.ledgers || [];
  const prevL = prevNote?.ledgers || [];

  const allLedgerItems: { id?: string; code: string; name: string; cNet: number; pNet: number }[] = [];
  const seen = new Set<string>();

  currL.forEach(l => {
    const code = l.ledger_code || '';
    const name = l.ledger_name;
    const matchKey = code ? `code_${code}` : `name_${name.toLowerCase()}`;
    seen.add(matchKey);

    const prevMatch = prevL.find(p => (code && p.ledger_code === code) || p.ledger_name.toLowerCase() === name.toLowerCase());
    allLedgerItems.push({
      id: l.id,
      code,
      name,
      cNet: l.net,
      pNet: prevMatch?.net ?? 0,
    });
  });

  prevL.forEach(p => {
    const code = p.ledger_code || '';
    const name = p.ledger_name;
    const matchKey = code ? `code_${code}` : `name_${name.toLowerCase()}`;
    if (!seen.has(matchKey)) {
      // Only in the prior year's data (not currently present) — nothing in
      // the current period to reclassify, so this row is never draggable.
      allLedgerItems.push({
        code,
        name,
        cNet: 0,
        pNet: p.net,
      });
    }
  });

  return (
    <div className={`note-block${dragOver ? ' note-drop-target' : ''}`} id={domId} {...dropProps}>
      <div className="note-hdr" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <span className="nn">Note {noteNo}</span>
          <span className="nb">{noteName}</span>
        </div>
        <div style={{ fontSize: 12, display: 'flex', gap: 12, alignItems: 'center' }}>
          {monthlyTrend && <Sparkline values={monthlyTrend} color={numTone(cTotal) === 'dn' ? '#D85A30' : '#378ADD'} />}
          <span>{financialYearLabel}: <strong>{symbol}{v(cTotal)}{sfx}</strong></span>
          <span style={{ color: 'var(--text2)' }}>{prevYearLabel}: <strong>{symbol}{v(pTotal)}{sfx}</strong></span>
          <span className={`bold ${numTone(totChg)}`}>
            YoY {vChg(totChg)}{sfx}
          </span>
        </div>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="fc-table">
          <thead>
            <tr>
              <th style={{ width: '40%' }}>Ledger</th>
              <th className="num">{financialYearLabel}</th>
              <th className="num" style={{ color: 'var(--text2)' }}>{prevYearLabel}</th>
              <th className="num">YoY Change</th>
            </tr>
          </thead>
          <tbody>
            {allLedgerItems.map((item, i) => {
              const chg = item.cNet - item.pNet;
              const draggableRow = canReclassify && !!item.id;
              return (
                <tr
                  key={item.code || item.name || i}
                  draggable={draggableRow}
                  onDragStart={draggableRow ? (e => handleDragStart(e, { ledgerId: item.id as string, ledgerName: item.name, sourceNoteNo: noteNo, sourceNoteName: noteName })) : undefined}
                  className={draggableRow ? 'draggable-row' : undefined}
                  title={draggableRow ? 'Drag onto another note to reclassify this ledger' : undefined}
                >
                  <td className="ind1">{item.name}</td>
                  <td className="num">{v(item.cNet)}</td>
                  <td className="num" style={{ color: 'var(--text2)' }}>{v(item.pNet)}</td>
                  <td className={`num ${numTone(chg)}`}>
                    {vChg(chg)}
                  </td>
                </tr>
              );
            })}
            <tr className="tot-row">
              <td className="bold">Total Note {noteNo}</td>
              <td className="num bold">{v(cTotal)}</td>
              <td className="num bold" style={{ color: 'var(--text2)' }}>{v(pTotal)}</td>
              <td className={`num bold ${numTone(totChg)}`}>
                {vChg(totChg)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function NotesTab() {
  const { bundle, threeYear, granularity, yearType, displayUnit, presentationCurrency, pendingNoteKey, clearPendingNoteKey, dataMode, user, refresh } = useDashboard();
  const [showComparison, setShowComparison] = useState(true);
  const [pendingReclassify, setPendingReclassify] = useState<PendingReclassify | null>(null);
  const [reclassifying, setReclassifying] = useState(false);
  const toast = useToast();

  // Reclassification writes real rows in tb_ledgers / ledger_master — only
  // offer it to roles that could already do the equivalent via the
  // Ledger Master screen, and only against real, persisted data (sample
  // mode's ledgers have no backing database row to update).
  const canReclassify = dataMode === 'api' && !!user && CAN_RECLASSIFY_ROLES.includes(user.role);

  // Jump-to-note requested from Balance Sheet / P&L: scroll to and briefly
  // highlight the specific note card, then clear the request so it doesn't
  // re-fire on an unrelated re-render or a later manual visit to this tab.
  // Runs after the notes render below (effects fire post-commit), so the
  // target element already exists in the DOM by the time this looks for it.
  useEffect(() => {
    if (!pendingNoteKey) return;
    jumpToNoteCard(pendingNoteKey);
    clearPendingNoteKey();
  });
  const unitLabel = getUnitHeader(displayUnit, presentationCurrency);

  async function confirmReclassify() {
    if (!pendingReclassify) return;
    setReclassifying(true);
    try {
      await apiFetch(`/tb/ledgers/${pendingReclassify.ledgerId}/reclassify`, {
        method: 'PATCH',
        body: JSON.stringify({ target_note_no: pendingReclassify.targetNoteNo, target_section: pendingReclassify.targetSection }),
      });
      toast(`Moved "${pendingReclassify.ledgerName}" to Note ${pendingReclassify.targetNoteNo} — ${pendingReclassify.targetNoteName}`);
      refresh();
    } catch (e) {
      const msg = e instanceof ApiClientError ? e.message : 'Reclassification failed';
      toast(msg);
    } finally {
      setReclassifying(false);
      setPendingReclassify(null);
    }
  }

  // ── 3-Year mode ────────────────────────────────────────────────────────────
  if (granularity === '3year' && threeYear) {
    const { years } = threeYear;
    const latestWithData = [...years].reverse().find(y => !y.no_data);

    return (
      <div>
        <ThreeYearBanner years={years} />
        <div className="info-bar" style={{ marginBottom: 16 }}>
          📋 Notes to Accounts are detailed single-year statements. In <strong>3-Year view</strong>, detailed ledger notes are not shown.
          {latestWithData && (
            <span> Switch to <strong>Annual</strong> view and select{' '}
              <strong>{latestWithData.financial_year.short_label || latestWithData.financial_year.label}</strong> to see the full Notes to Accounts.
            </span>
          )}
        </div>

        {/* Summary table: note totals per year */}
        <div className="card">
          <div className="card-hdr">
            <span className="ct">Notes — Year-end Summary ({unitLabel})</span>
            <span className="cbadge cb-blue">Annual · Closing Balances</span>
          </div>
          <div className="card-body">
            <div style={{ overflowX: 'auto' }}>
              <table className="fc-table">
                <thead>
                  <tr>
                    <th>Section</th>
                    {years.map(y => (
                      <th key={y.financial_year.id} className="num">
                        {y.financial_year.short_label || y.financial_year.label}
                        {y.no_data && <div style={{ fontSize: 9, fontWeight: 400, color: 'var(--text3)' }}>(No data)</div>}
                      </th>
                    ))}
                    {Array.from({ length: Math.max(0, 3 - years.length) }).map((_, i) => (
                      <th key={`g${i}`} className="num" style={{ color: 'var(--text3)', fontStyle: 'italic', fontSize: 10 }}>Upload TB</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    { label: 'Total Assets', get: (y: typeof years[0]) => y.bs_summary?.total_assets },
                    { label: 'Equity',       get: (y: typeof years[0]) => y.bs_summary?.equity },
                    { label: 'Revenue',      get: (y: typeof years[0]) => y.mis?.rev },
                    { label: 'PAT',          get: (y: typeof years[0]) => y.mis?.pat },
                  ].map(r => (
                    <tr key={r.label}>
                      <td>{r.label}</td>
                      {years.map(y => (
                        <td key={y.financial_year.id} className="num">
                          {y.no_data ? <span style={{ color: 'var(--text3)', fontStyle: 'italic' }}>—</span> : fn(r.get(y) ?? 0, 2, displayUnit)}
                        </td>
                      ))}
                      {Array.from({ length: Math.max(0, 3 - years.length) }).map((_, i) => (
                        <td key={`g${i}`} className="num" style={{ color: 'var(--text3)', fontStyle: 'italic' }}>—</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Single-year mode ───────────────────────────────────────────────────────
  if (!bundle) return null;
  const {
    notes = [],
    prev_notes: prevNotes = [],
    financial_year,
    prev_financial_year: prevFy,
    period_label,
  } = bundle;

  const hasPrev = !!(prevNotes && prevNotes.length > 0 && prevFy);
  const compare = hasPrev && showComparison;

  // Build combined list of notes sorted by note_no and section
  const getNoteKey = (n: AggregatedNote) => `${isBSSection(n.section) ? 'bs' : 'pl'}_${n.note_no}`;

  const allNoteKeys = Array.from(
    new Set([...notes.map(getNoteKey), ...(prevNotes || []).map(getNoteKey)])
  );

  const combinedNotes = allNoteKeys.map(key => {
    const curr = notes.find(n => getNoteKey(n) === key);
    const prev = (prevNotes || []).find(pn => getNoteKey(pn) === key);
    const noteNo = curr?.note_no || prev?.note_no || 0;
    return { key, noteNo, curr, prev };
  }).sort((a, b) => a.noteNo - b.noteNo);

  // Note cards without any current-period ledgers still let a user *drop*
  // something onto them (e.g. the very bug this feature exists to fix — a
  // real Fixed Deposit ledger sat under Cash & Bank because Note 20's own
  // card had nothing in it to receive a correction, so it never rendered
  // at all). Only notes with zero ledgers in *both* years are added here —
  // any note already in combinedNotes above already has its own real card.
  const emptyTargetNotes = canReclassify
    ? NOTE_CATALOG.filter(cat => !combinedNotes.some(c => c.noteNo === cat.note_no && (c.curr?.section || c.prev?.section) === cat.section))
    : [];

  const fyFullLabel = getFyLabel(financial_year, yearType);
  const fyLabel = getFyShortLabel(financial_year, yearType);
  const prevFyLabel = getFyShortLabel(prevFy, yearType);

  // Real, already-computed KPI summary + a compact "Note Index" (contents
  // page) — same pair the bespoke Notes PDF export already has (previously
  // only available on download): a real audited statement's own "Notes
  // forming part of the accounts" always opens with an index like this, and
  // with up to 26 note cards to scroll through, an at-a-glance summary that
  // jumps straight to any one is a genuine navigation aid, not just parity.
  const SECTION_LABEL: Record<string, string> = { eq: 'Equity', lnc: 'Non-Curr. Liab.', lc: 'Curr. Liab.', anc: 'Non-Curr. Assets', ac: 'Curr. Assets', inc: 'Income', exp: 'Expense' };
  const sectionSum = (list: AggregatedNote[], sections: string[]) =>
    list.filter(n => sections.includes(n.section || '')).reduce((s, n) => s + n.total, 0);
  const plSum = (list: AggregatedNote[]) =>
    list.filter(n => ['inc', 'exp'].includes(n.section || '')).reduce((s, n) => s + Math.abs(n.total), 0);
  const eqLiabTotal = sectionSum(notes, ['eq', 'lnc', 'lc']);
  const assetsTotal = sectionSum(notes, ['anc', 'ac']);
  const plTotal = plSum(notes);
  const bsNoteCount = combinedNotes.filter(c => isBSSection(c.curr?.section || c.prev?.section)).length;
  // Real prior-year figures for the same 3 currency KPIs — the identical
  // prevNotes array already used a few lines below for the Note Index/
  // per-note comparison mode, just not previously read up here too (found
  // auditing this tab: the KPI strip showed only static/neutral captions
  // even with real YoY data sitting right there in scope).
  const prevEqLiabTotal = hasPrev ? sectionSum(prevNotes, ['eq', 'lnc', 'lc']) : null;
  const prevAssetsTotal = hasPrev ? sectionSum(prevNotes, ['anc', 'ac']) : null;
  const prevPlTotal = hasPrev ? plSum(prevNotes) : null;
  const yoyPct = (curr: number, prev: number | null) => prev != null && prev !== 0 ? ((curr - prev) / Math.abs(prev)) * 100 : null;
  const eqLiabYoy = yoyPct(eqLiabTotal, prevEqLiabTotal);
  const assetsYoy = yoyPct(assetsTotal, prevAssetsTotal);
  const plYoy = yoyPct(plTotal, prevPlTotal);

  // Split in two, per Balance Sheet/P&L/Cash Flow's own already-corrected
  // architecture (see their doc comments / dashboard-builder-engine.ts's
  // TabKey doc comment for why this shape, not a single CustomizableTabPanel
  // wrap, is mandatory for a Schedule III statutory statement): only the
  // real supplementary/navigation content (the KPI strip + Note Index) goes
  // inside CustomizableTabPanel's fixedView. Every individual note card
  // renders directly in this component, unconditionally, and is never
  // passed to CustomizableTabPanel at all — so it can never be swapped out
  // for the widget grid.

  // ── Supplementary zone (customizable) — KPI strip + Note Index ──
  const supplementaryView = (
    <div>
      <div className="grid4">
        <Kpi label="Total Notes" value={String(combinedNotes.length)} change={`${bsNoteCount} Balance Sheet, ${combinedNotes.length - bsNoteCount} P&L`} tone="neu" />
        <Kpi label="Equity & Liabilities Notes" value={fn(eqLiabTotal, 2, displayUnit)} change={eqLiabYoy != null ? `${signedPct(eqLiabYoy)} YoY` : 'Notes 1-19 range'} tone={eqLiabYoy != null ? kpiTone(eqLiabYoy) : 'neu'} />
        <Kpi label="Assets Notes" value={fn(assetsTotal, 2, displayUnit)} change={assetsYoy != null ? `${signedPct(assetsYoy)} YoY` : 'Non-current + Current'} tone={assetsYoy != null ? kpiTone(assetsYoy) : 'neu'} />
        <Kpi label="Income & Expense Notes" value={fn(plTotal, 2, displayUnit)} change={plYoy != null ? `${signedPct(plYoy)} YoY` : 'Notes 20-26 range'} tone={plYoy != null ? kpiTone(plYoy) : 'neu'} />
      </div>

      <div className="card">
        <div className="card-hdr">
          <span className="ct">Note Index</span>
          <span className="cbadge cb-blue">Click a row to jump to its detail</span>
        </div>
        <div className="card-body" style={{ overflowX: 'auto' }}>
          <table className="fc-table">
            <thead>
              <tr>
                <th>Note</th>
                <th>Description</th>
                <th>Section</th>
                <th className="num">{fyLabel}</th>
                {compare && <th className="num" style={{ color: 'var(--text2)' }}>{prevFyLabel}</th>}
                {compare && <th className="num">YoY</th>}
              </tr>
            </thead>
            <tbody>
              {combinedNotes.map(({ key, noteNo, curr, prev }) => {
                const name = curr?.note_name || prev?.note_name || `Note ${noteNo}`;
                const sec = curr?.section || prev?.section || '';
                const cVal = curr?.total ?? 0;
                const pVal = prev?.total ?? 0;
                const chg = cVal - pVal;
                return (
                  <tr key={key} onClick={() => jumpToNoteCard(key)} style={{ cursor: 'pointer' }} title={`Jump to Note ${noteNo}`}>
                    <td>{noteNo}</td>
                    <td>{name}</td>
                    <td style={{ fontSize: 11, color: 'var(--text2)' }}>{SECTION_LABEL[sec] || sec}</td>
                    <td className="num">{fn(cVal, 2, displayUnit)}</td>
                    {compare && <td className="num" style={{ color: 'var(--text2)' }}>{fn(pVal, 2, displayUnit)}</td>}
                    {compare && <td className={`num ${numTone(chg)}`}>{formatChg(chg, 2, displayUnit)}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );

  return (
    <div>
      <DownloadBar title={`Notes to Accounts · ${fyFullLabel}`} subtitle={`Notes 1–26 · ${unitLabel} · ${period_label}`} section="notes" compareEnabled={showComparison} />

      <CustomizableTabPanel tabKey="notes" defaultWidgets={NOTES_DEFAULT_WIDGETS} fixedView={supplementaryView} />

      {/* ── Fixed zone (never a widget, never wrapped, never swapped out) ──
          The mandated Schedule III note schedule — every individual note
          card, every ledger line, every Sparkline, byte-identical to how it
          always rendered, whether or not the supplementary zone above is
          being customized right now. */}
      <ConfirmModal
        open={!!pendingReclassify}
        title="Reclassify Ledger"
        message={pendingReclassify
          ? `Move "${pendingReclassify.ledgerName}" from Note ${pendingReclassify.sourceNoteNo} (${pendingReclassify.sourceNoteName}) to Note ${pendingReclassify.targetNoteNo} (${pendingReclassify.targetNoteName})? This updates every year this ledger appears in, and how it's classified on every future sync.`
          : ''}
        confirmLabel="Move Ledger"
        cancelLabel="Cancel"
        danger={false}
        busy={reclassifying}
        onConfirm={confirmReclassify}
        onCancel={() => setPendingReclassify(null)}
      />

      {/* Control bar for comparison */}
      <div className="card" style={{ padding: '10px 16px', marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>
          Notes to Accounts Breakdown <span className="cbadge cb-blue">IND AS Schedule III</span>
        </div>

        {hasPrev ? (
          <label style={{ fontSize: 12, color: 'var(--text2)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, userSelect: 'none' }}>
            <input
              type="checkbox"
              checked={showComparison}
              onChange={e => setShowComparison(e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
            Compare with {prevFyLabel}
          </label>
        ) : (
          <span style={{ fontSize: 11, color: 'var(--text2)', fontStyle: 'italic' }}>
            Showing {fyLabel} notes only (Prior year data not available)
          </span>
        )}
      </div>

      {!hasPrev && (
        <div className="info-bar mb-3" style={{ background: 'var(--blue-l, #eff6ff)', border: '1px solid var(--blue-border, #bfdbfe)', color: 'var(--blue-d, #1e40af)', margin: '0 0 16px 0', borderRadius: 6, padding: '8px 12px', fontSize: 12 }}>
          ℹ Previous year data is not available. Displaying <strong>{fyFullLabel}</strong> Notes to Accounts only. Upload previous year Trial Balance to enable 2-Year prior year note comparison.
        </div>
      )}

      {canReclassify && (
        <div className="info-bar" style={{ margin: '0 0 16px 0', fontSize: 12 }}>
          💡 See a ledger under the wrong note? Drag it onto the correct note&apos;s card to reclassify it — updates every year this ledger appears in, and how it&apos;s classified on every future sync.
        </div>
      )}

      {combinedNotes.map(({ key, noteNo, curr, prev }) => (
        <SingleNoteCard
          key={key}
          noteKey={key}
          currNote={curr}
          prevNote={prev}
          noteNo={noteNo}
          financialYearLabel={fyLabel}
          prevYearLabel={prevFyLabel}
          compare={compare}
          unit={displayUnit}
          currency={presentationCurrency}
          canReclassify={canReclassify}
          onRequestReclassify={setPendingReclassify}
        />
      ))}

      {!combinedNotes.length && <div className="notice">No ledger notes available for this period.</div>}

      {emptyTargetNotes.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-hdr">
            <span className="ct">Other Notes (Empty This Period)</span>
            <span className="cbadge cb-blue" title="These notes have no ledgers in the current period — drop a ledger here if it genuinely belongs under one of them.">Drop Targets</span>
          </div>
          <div className="card-body" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {emptyTargetNotes.map(cat => (
              <div
                key={`${cat.note_no}-${cat.section}`}
                onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                onDrop={e => {
                  e.preventDefault();
                  let payload: DragPayload;
                  try { payload = JSON.parse(e.dataTransfer.getData('application/json')); } catch { return; }
                  setPendingReclassify({ ...payload, targetNoteNo: cat.note_no, targetSection: cat.section, targetNoteName: cat.note_name });
                }}
                style={{ padding: '8px 14px', borderRadius: 8, border: '1px dashed var(--border2, #cbd5e1)', fontSize: 12, color: 'var(--text2)', background: 'var(--bg2)' }}
                title={`Note ${cat.note_no} — ${cat.note_name} currently has no ledgers this period`}
              >
                Note {cat.note_no} — {cat.note_name}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
