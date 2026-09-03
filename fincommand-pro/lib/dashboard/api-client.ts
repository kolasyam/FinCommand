'use client';

/**
 * Browser-side API client for the dashboard. Same contract as the original
 * frontend's apiFetch()/tryRefresh(): bearer token from localStorage,
 * auto-refresh once on 401, and errors are always surfaced (never silently
 * swallowed into a sample-data fallback — that was the original app's core
 * bug; here an API failure always reaches the caller as a thrown Error).
 */

const TOKEN_KEY = 'fc_token';
const REFRESH_KEY = 'fc_refresh_token';
const USER_KEY = 'fc_user';
const FY_KEY = 'fc_fy_id';

export interface StoredUser {
  id: string; name: string; email: string; role: string;
  company_id: string; company_name: string;
}

function ls(): Storage | null {
  return typeof window !== 'undefined' ? window.localStorage : null;
}

export function getToken(): string | null { return ls()?.getItem(TOKEN_KEY) ?? null; }
export function getRefreshToken(): string | null { return ls()?.getItem(REFRESH_KEY) ?? null; }
export function getStoredUser(): StoredUser | null {
  const raw = ls()?.getItem(USER_KEY);
  return raw ? JSON.parse(raw) : null;
}
export function getStoredFyId(): string | null { return ls()?.getItem(FY_KEY) ?? null; }
export function setStoredFyId(id: string): void { ls()?.setItem(FY_KEY, id); }

export function storeSession(accessToken: string, refreshToken: string, user: StoredUser): void {
  ls()?.setItem(TOKEN_KEY, accessToken);
  ls()?.setItem(REFRESH_KEY, refreshToken);
  ls()?.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession(): void {
  ls()?.removeItem(TOKEN_KEY);
  ls()?.removeItem(REFRESH_KEY);
  ls()?.removeItem(USER_KEY);
  ls()?.removeItem(FY_KEY);
}

export class ApiClientError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

async function tryRefresh(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  try {
    const r = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!r.ok) return false;
    const d = await r.json();
    ls()?.setItem(TOKEN_KEY, d.access_token);
    return true;
  } catch {
    return false;
  }
}

export async function apiFetch<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  let token = getToken();

  // Auto-refresh access token if missing but refresh token exists
  if (!token && getRefreshToken()) {
    await tryRefresh();
    token = getToken();
  }

  const isPublicAuthRoute = path.startsWith('/auth/login') || path.startsWith('/auth/signup') || path.startsWith('/auth/refresh');
  if (!token && !isPublicAuthRoute) {
    clearSession();
    throw new ApiClientError('Session expired. Please sign in again.', 401);
  }

  const isFormData = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  const headers: Record<string, string> = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(opts.headers as Record<string, string> | undefined),
  };

  let res = await fetch(`/api/v1${path}`, { ...opts, headers });

  if (res.status === 401 && getRefreshToken()) {
    const ok = await tryRefresh();
    if (ok) {
      const newToken = getToken();
      if (newToken) headers.Authorization = `Bearer ${newToken}`;
      res = await fetch(`/api/v1${path}`, { ...opts, headers });
    } else {
      clearSession();
      throw new ApiClientError('Session expired. Please sign in again.', 401);
    }
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new ApiClientError(err.error || `HTTP ${res.status}`, res.status);
  }
  return res.json();
}
