import { canViewCustomTab, parseSharingInput, describeSharing, type TabAccessFields } from '@/lib/dashboard-builder/tab-access';

const CREATOR = 'user-creator';
const tab = (t: Partial<TabAccessFields>): TabAccessFields => ({ visibility: 'company', sharedRoles: [], createdBy: CREATOR, ...t });

describe('canViewCustomTab', () => {
  test('company-wide tabs are visible to every role (the pre-sharing default)', () => {
    for (const role of ['admin', 'cfo', 'ceo', 'auditor', 'manager', 'viewer']) {
      expect(canViewCustomTab(tab({}), { id: 'someone', role })).toBe(true);
    }
  });
  test('role-shared tabs: only the listed roles (plus admin and the creator)', () => {
    const t = tab({ visibility: 'roles', sharedRoles: ['cfo', 'ceo'] });
    expect(canViewCustomTab(t, { id: 'x', role: 'ceo' })).toBe(true);
    expect(canViewCustomTab(t, { id: 'x', role: 'viewer' })).toBe(false);
    expect(canViewCustomTab(t, { id: 'x', role: 'manager' })).toBe(false);
    expect(canViewCustomTab(t, { id: 'x', role: 'admin' })).toBe(true);
    expect(canViewCustomTab(t, { id: CREATOR, role: 'manager' })).toBe(true);
  });
  test('private tabs: only the creator and admins', () => {
    const t = tab({ visibility: 'private' });
    expect(canViewCustomTab(t, { id: CREATOR, role: 'cfo' })).toBe(true);
    expect(canViewCustomTab(t, { id: 'other-cfo', role: 'cfo' })).toBe(false);
    expect(canViewCustomTab(t, { id: 'an-admin', role: 'admin' })).toBe(true);
  });
  test('a tab with no recorded creator is still governed by its visibility', () => {
    expect(canViewCustomTab(tab({ visibility: 'private', createdBy: null }), { id: 'x', role: 'cfo' })).toBe(false);
  });
});

describe('parseSharingInput', () => {
  test('company / private ignore any role list', () => {
    expect(parseSharingInput('company', ['cfo'])).toEqual({ ok: true, visibility: 'company', sharedRoles: [] });
    expect(parseSharingInput('private', undefined)).toEqual({ ok: true, visibility: 'private', sharedRoles: [] });
  });
  test('roles: de-duplicated, canonical order, at least one', () => {
    expect(parseSharingInput('roles', ['viewer', 'cfo', 'cfo'])).toEqual({ ok: true, visibility: 'roles', sharedRoles: ['cfo', 'viewer'] });
    expect(parseSharingInput('roles', []).ok).toBe(false);
    expect(parseSharingInput('roles', 'cfo').ok).toBe(false);
  });
  test('rejects an unknown visibility or role', () => {
    expect(parseSharingInput('public', []).ok).toBe(false);
    expect(parseSharingInput('roles', ['cfo', 'superuser'])).toEqual({ ok: false, error: 'Unknown role(s): superuser' });
  });
});

test('describeSharing reads naturally', () => {
  expect(describeSharing({ visibility: 'company', sharedRoles: [] })).toBe('Everyone in the company');
  expect(describeSharing({ visibility: 'roles', sharedRoles: ['cfo', 'ceo'] })).toBe('CFO, CEO (and admins)');
  expect(describeSharing({ visibility: 'private', sharedRoles: [] })).toBe('Only the creator (and admins)');
});
