'use client';

/**
 * The one place to create and manage custom dashboard tabs.
 *
 * Create: name/icon/description, a starting point from the template gallery
 * (Blank, a curated finance template, or a copy of any tab you can see), and
 * who it's shared with (everyone / selected roles / only me). Nothing is
 * persisted until "Create" — the tab and its starting layout are then
 * created together in one server transaction, so an abandoned flow leaves
 * nothing behind.
 *
 * Manage: rename and re-share (sharing is enforced server-side on every
 * route — see lib/dashboard-builder/tab-access.ts), or delete with a warning
 * that shows how many saved views go with it.
 */
import { useState } from 'react';
import { useDashboard } from '@/lib/dashboard/DashboardContext';
import { useToast } from '@/lib/dashboard/ToastContext';
import { useCustomTabs } from '@/lib/dashboard/CustomTabsContext';
import { ApiClientError } from '@/lib/dashboard/api-client';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import type { CustomTabDTO } from '@/lib/dashboard/custom-tabs-api';
import { DASHBOARD_TEMPLATES } from '@/lib/dashboard-builder/templates';
import {
  SHAREABLE_ROLES, ROLE_LABELS, describeSharing, type TabVisibility,
} from '@/lib/dashboard-builder/tab-access';

// Mirrors ROLE_SETS.isCFO in lib/auth/permissions.ts — the API routes re-check it.
const CAN_MANAGE_CUSTOM_TABS_ROLES = ['admin', 'cfo'];

/** Fixed tabs a new tab can be copied from (sidebar names). */
const COPYABLE_FIXED_TABS: { key: string; name: string }[] = [
  { key: 'overview', name: 'Executive Overview' }, { key: 'my-dashboard', name: 'My Dashboard' },
  { key: 'mis', name: 'MIS Report' }, { key: 'ratios', name: 'Ratio Analysis' }, { key: 'wc', name: 'Working Capital' },
  { key: 'funds', name: 'Treasury' }, { key: 'customer-margin', name: 'Customer Margin' },
  { key: 'vendor-expense', name: 'Vendor Expense' }, { key: 'boardpack', name: 'Board Pack' },
  { key: 'bs', name: 'Balance Sheet (KPI zone)' }, { key: 'pl', name: 'P&L Account (KPI zone)' },
  { key: 'cashflow', name: 'Cash Flow (KPI zone)' }, { key: 'notes', name: 'Notes to Accounts (KPI zone)' },
];

type StartFrom = { kind: 'blank' } | { kind: 'template'; key: string } | { kind: 'copy'; tabKey: string };

function SharingEditor({ visibility, roles, onChange }: {
  visibility: TabVisibility; roles: string[];
  onChange: (v: TabVisibility, roles: string[]) => void;
}) {
  const options: { v: TabVisibility; label: string; hint: string }[] = [
    { v: 'company', label: 'Everyone', hint: 'All users in the company' },
    { v: 'roles', label: 'Selected roles', hint: 'Only the roles you tick (admins always see every tab)' },
    { v: 'private', label: 'Only me', hint: 'Just you (and admins)' },
  ];
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: visibility === 'roles' ? 8 : 0 }} role="radiogroup" aria-label="Who can see this tab">
        {options.map((o) => (
          <button
            key={o.v} type="button" role="radio" aria-checked={visibility === o.v} title={o.hint}
            onClick={() => onChange(o.v, o.v === 'roles' ? (roles.length ? roles : ['cfo', 'ceo']) : [])}
            style={{ ...SEGMENT_STYLE, ...(visibility === o.v ? SEGMENT_ACTIVE : {}) }}
          >{o.label}</button>
        ))}
      </div>
      {visibility === 'roles' && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {SHAREABLE_ROLES.map((r) => (
            <label key={r} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#e5e7eb', cursor: 'pointer' }}>
              <input
                type="checkbox" checked={roles.includes(r)}
                onChange={(e) => onChange('roles', e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))}
              />
              {ROLE_LABELS[r]}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export function ManageCustomTabsModal({
  open, onClose, onOpenTab,
}: {
  open: boolean;
  onClose: () => void;
  /** Called with the new tab's tabKey right after a successful create, so the caller can navigate straight into it. */
  onOpenTab: (tabKey: string) => void;
}) {
  const { user } = useDashboard();
  const toast = useToast();
  const { tabs, createTab, updateTab, deleteTab } = useCustomTabs();
  const canManage = !!user && CAN_MANAGE_CUSTOM_TABS_ROLES.includes(user.role);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newIcon, setNewIcon] = useState('');
  const [startFrom, setStartFrom] = useState<StartFrom>({ kind: 'blank' });
  const [newVisibility, setNewVisibility] = useState<TabVisibility>('company');
  const [newRoles, setNewRoles] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editVisibility, setEditVisibility] = useState<TabVisibility>('company');
  const [editRoles, setEditRoles] = useState<string[]>([]);
  const [editSaving, setEditSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<CustomTabDTO | null>(null);
  const [deleting, setDeleting] = useState(false);

  if (!open) return null;

  function resetCreateForm() {
    setCreating(false);
    setNewName(''); setNewDescription(''); setNewIcon('');
    setStartFrom({ kind: 'blank' });
    setNewVisibility('company'); setNewRoles([]);
  }

  const sharingValid = (v: TabVisibility, roles: string[]) => v !== 'roles' || roles.length > 0;

  async function handleCreate() {
    const name = newName.trim();
    if (!name || !sharingValid(newVisibility, newRoles)) return;
    setSaving(true);
    try {
      const tab = await createTab({
        name,
        description: newDescription.trim() || undefined,
        icon: newIcon.trim() || undefined,
        visibility: newVisibility,
        sharedRoles: newVisibility === 'roles' ? newRoles : [],
        ...(startFrom.kind === 'template' ? { template: startFrom.key } : {}),
        ...(startFrom.kind === 'copy' ? { copyFromTabKey: startFrom.tabKey } : {}),
      });
      toast(`"${tab.name}" created`);
      resetCreateForm();
      onClose();
      onOpenTab(tab.tabKey);
    } catch (e) {
      toast(e instanceof ApiClientError ? e.message : 'Failed to create this tab');
    } finally {
      setSaving(false);
    }
  }

  function startEdit(tab: CustomTabDTO) {
    setEditingId(tab.id);
    setEditName(tab.name);
    setEditVisibility(tab.visibility);
    setEditRoles(tab.sharedRoles);
  }

  async function handleEditSave(tab: CustomTabDTO) {
    const name = editName.trim();
    if (!name || !sharingValid(editVisibility, editRoles)) return;
    setEditSaving(true);
    try {
      await updateTab(tab.id, { name, visibility: editVisibility, sharedRoles: editVisibility === 'roles' ? editRoles : [] });
      setEditingId(null);
      toast('Tab updated');
    } catch (e) {
      toast(e instanceof ApiClientError ? e.message : 'Failed to update this tab');
    } finally {
      setEditSaving(false);
    }
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const { layoutsRemoved } = await deleteTab(deleteTarget.id);
      toast(`"${deleteTarget.name}" deleted${layoutsRemoved > 0 ? ` — ${layoutsRemoved} saved view${layoutsRemoved === 1 ? '' : 's'} removed with it` : ''}`);
      setDeleteTarget(null);
    } catch (e) {
      toast(e instanceof ApiClientError ? e.message : 'Failed to delete this tab');
    } finally {
      setDeleting(false);
    }
  }

  const copyOptions = [
    ...COPYABLE_FIXED_TABS,
    ...tabs.map((t) => ({ key: t.tabKey, name: `${t.icon ?? '📌'} ${t.name}` })),
  ];

  return (
    <div style={OVERLAY_STYLE} onClick={onClose}>
      <div style={{ ...PANEL_STYLE, width: creating ? 760 : 560 }} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Custom tabs">
        <div style={{ fontSize: 16, fontWeight: 700, color: '#fff', marginBottom: 4 }}>Custom tabs</div>
        <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 16 }}>
          Your company&apos;s own dashboard tabs — start blank, from a template, or from any existing tab, and choose exactly who can see each one.
        </div>

        {canManage && (
          <div style={{ marginBottom: 16, padding: 14, borderRadius: 10, background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.08)' }}>
            {!creating ? (
              <button className="btn btn-pr" onClick={() => setCreating(true)}>+ New custom tab</button>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '56px 1fr 1fr', gap: 8, marginBottom: 12 }}>
                  <div>
                    <label style={LABEL_STYLE}>Icon</label>
                    <input value={newIcon} onChange={(e) => setNewIcon(e.target.value)} placeholder="📌" maxLength={10} style={INPUT_STYLE} aria-label="Icon" />
                  </div>
                  <div>
                    <label style={LABEL_STYLE}>Name</label>
                    <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Board Metrics" maxLength={100} style={INPUT_STYLE} autoFocus aria-label="Name" />
                  </div>
                  <div>
                    <label style={LABEL_STYLE}>Description (optional)</label>
                    <input value={newDescription} onChange={(e) => setNewDescription(e.target.value)} maxLength={300} style={INPUT_STYLE} aria-label="Description" />
                  </div>
                </div>

                <label style={LABEL_STYLE}>Start from</label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 12 }}>
                  <button
                    type="button" onClick={() => setStartFrom({ kind: 'blank' })} aria-pressed={startFrom.kind === 'blank'}
                    style={{ ...CARD_STYLE, ...(startFrom.kind === 'blank' ? CARD_ACTIVE : {}) }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600 }}>⬜ Blank</div>
                    <div style={CARD_SUB}>An empty grid — add widgets yourself.</div>
                  </button>
                  {DASHBOARD_TEMPLATES.map((t) => {
                    const active = startFrom.kind === 'template' && startFrom.key === t.key;
                    return (
                      <button
                        key={t.key} type="button" onClick={() => setStartFrom({ kind: 'template', key: t.key })} aria-pressed={active}
                        title={t.highlights.join(' · ')}
                        style={{ ...CARD_STYLE, ...(active ? CARD_ACTIVE : {}) }}
                      >
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{t.icon} {t.name}</div>
                        <div style={CARD_SUB}>{t.description}</div>
                        <div style={{ ...CARD_SUB, color: '#6b7280', marginTop: 4 }}>{t.widgets.length} widgets</div>
                      </button>
                    );
                  })}
                  <div style={{ ...CARD_STYLE, ...(startFrom.kind === 'copy' ? CARD_ACTIVE : {}), cursor: 'default' }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>⧉ Copy a tab</div>
                    <div style={CARD_SUB}>Start from what you see on an existing tab.</div>
                    <select
                      value={startFrom.kind === 'copy' ? startFrom.tabKey : ''}
                      onChange={(e) => setStartFrom(e.target.value ? { kind: 'copy', tabKey: e.target.value } : { kind: 'blank' })}
                      style={{ ...INPUT_STYLE, marginTop: 6, padding: '6px 8px', cursor: 'pointer' }} aria-label="Tab to copy"
                    >
                      <option value="">Choose a tab…</option>
                      {copyOptions.map((o) => <option key={o.key} value={o.key}>{o.name}</option>)}
                    </select>
                  </div>
                </div>

                <label style={LABEL_STYLE}>Who can see it</label>
                <div style={{ marginBottom: 12 }}>
                  <SharingEditor visibility={newVisibility} roles={newRoles} onChange={(v, r) => { setNewVisibility(v); setNewRoles(r); }} />
                  {!sharingValid(newVisibility, newRoles) && <div style={{ fontSize: 10, color: '#f87171', marginTop: 4 }}>Pick at least one role.</div>}
                </div>

                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button className="btn btn-cancel-dark" onClick={resetCreateForm}>Cancel</button>
                  <button className="btn btn-pr" disabled={!newName.trim() || !sharingValid(newVisibility, newRoles) || saving} onClick={handleCreate}>
                    {saving ? 'Creating…' : 'Create'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        <div style={{ maxHeight: 340, overflowY: 'auto' }}>
          {tabs.length === 0 && (
            <div style={{ fontSize: 12, color: '#6b7280', textAlign: 'center', padding: '20px 0' }}>
              {canManage ? 'No custom tabs yet — create one above.' : 'No custom tabs are shared with you yet.'}
            </div>
          )}
          {tabs.map((tab) => (
            <div key={tab.id} style={{ padding: '10px 4px', borderBottom: '1px solid rgba(255,255,255,.06)' }}>
              {editingId === tab.id ? (
                <div>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                    <input
                      value={editName} onChange={(e) => setEditName(e.target.value)} maxLength={100}
                      style={{ ...INPUT_STYLE, padding: '6px 9px' }} autoFocus aria-label="Tab name"
                      onKeyDown={(e) => { if (e.key === 'Enter') handleEditSave(tab); if (e.key === 'Escape') setEditingId(null); }}
                    />
                  </div>
                  <SharingEditor visibility={editVisibility} roles={editRoles} onChange={(v, r) => { setEditVisibility(v); setEditRoles(r); }} />
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 8 }}>
                    <button className="btn btn-cancel-dark btn-sm" onClick={() => setEditingId(null)}>Cancel</button>
                    <button className="btn btn-pr btn-sm" disabled={editSaving || !editName.trim() || !sharingValid(editVisibility, editRoles)} onClick={() => handleEditSave(tab)}>
                      {editSaving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ fontSize: 18 }}>{tab.icon || '📌'}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#e5e7eb', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tab.name}</span>
                      <span style={BADGE_STYLE} title={describeSharing(tab)}>
                        {tab.visibility === 'company' ? 'Everyone' : tab.visibility === 'private' ? 'Private' : 'Shared'}
                      </span>
                    </div>
                    <div style={{ fontSize: 10, color: '#6b7280' }}>
                      {describeSharing(tab)} · {tab.layoutCount} saved view{tab.layoutCount === 1 ? '' : 's'}
                      {tab.createdByName ? ` · by ${tab.createdByName}` : ''} · {new Date(tab.createdAt).toLocaleDateString('en-IN')}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 4, flex: 'none' }}>
                    <button className="btn btn-cancel-dark btn-sm" onClick={() => { onClose(); onOpenTab(tab.tabKey); }}>Open</button>
                    {canManage && (
                      <>
                        <button className="btn btn-cancel-dark btn-sm" onClick={() => startEdit(tab)} title="Rename / share" aria-label={`Edit ${tab.name}`}>✎</button>
                        <button className="btn btn-cancel-dark btn-sm" onClick={() => setDeleteTarget(tab)} title="Delete" aria-label={`Delete ${tab.name}`}>🗑</button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn btn-cancel-dark" onClick={onClose}>Close</button>
        </div>
      </div>

      <ConfirmModal
        open={!!deleteTarget}
        title={`Delete "${deleteTarget?.name}"?`}
        message={
          deleteTarget && deleteTarget.layoutCount > 0
            ? `This removes the tab and ${deleteTarget.layoutCount} saved view${deleteTarget.layoutCount === 1 ? '' : 's'} on it (personal views and the company default). This can't be undone.`
            : "This removes the tab. This can't be undone."
        }
        confirmLabel="Delete"
        busy={deleting}
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

const OVERLAY_STYLE: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'rgba(6,10,18,.55)', backdropFilter: 'blur(8px)',
};
const PANEL_STYLE: React.CSSProperties = {
  width: 460, maxWidth: 'calc(100vw - 32px)', background: '#0f1826',
  border: '1px solid rgba(255,255,255,.1)', borderRadius: 14, padding: 24,
  boxShadow: '0 24px 60px rgba(0,0,0,.5)', maxHeight: '90vh', overflowY: 'auto',
};
const INPUT_STYLE: React.CSSProperties = {
  width: '100%', padding: '9px 11px', fontSize: 12, border: '1px solid rgba(255,255,255,.14)',
  borderRadius: 8, color: '#e5e7eb', background: 'rgba(255,255,255,.04)', outline: 'none',
};
const LABEL_STYLE: React.CSSProperties = {
  fontSize: 10, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 500,
  display: 'block', marginBottom: 5,
};
const CARD_STYLE: React.CSSProperties = {
  textAlign: 'left', padding: '10px 11px', borderRadius: 9, cursor: 'pointer',
  border: '1px solid rgba(255,255,255,.14)', background: 'transparent', color: '#e5e7eb', minHeight: 92,
};
const CARD_ACTIVE: React.CSSProperties = { borderColor: '#5b9fe0', background: 'rgba(24,95,165,.28)' };
const CARD_SUB: React.CSSProperties = { fontSize: 10.5, color: '#9ca3af', marginTop: 3, lineHeight: 1.35 };
const SEGMENT_STYLE: React.CSSProperties = {
  flex: 1, padding: '7px 10px', fontSize: 12, borderRadius: 8, cursor: 'pointer',
  border: '1px solid rgba(255,255,255,.14)', background: 'transparent', color: '#d1d5db',
};
const SEGMENT_ACTIVE: React.CSSProperties = { background: 'rgba(24,95,165,.35)', borderColor: '#5b9fe0', color: '#fff', fontWeight: 600 };
const BADGE_STYLE: React.CSSProperties = {
  fontSize: 9, padding: '1px 6px', borderRadius: 999, border: '1px solid rgba(91,159,224,.4)', color: '#93c5fd', flex: 'none',
};
