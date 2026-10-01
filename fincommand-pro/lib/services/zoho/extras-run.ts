import axios from 'axios';
import { query } from '@/lib/db/neon';
import { pgExtrasStore } from '@/lib/ingestion/zoho-extras';
import { callZoho, ZOHO_API } from './client';
import { fileNameFromDisposition, runExtrasSlice, type BinaryResponse, type ExtrasDeps, type ExtrasResult } from './extras';
import { openZohoSession } from './records-sync';
import { blockZohoUntil, flushZohoUsage, getZohoUsage } from './usage';

/** One budgeted slice of the extras read (comments, attached files, bank statements) against the real Zoho connection. */
export async function runScheduledExtras(companyId: string, opts: { maxCalls: number; deadlineAt: number }): Promise<ExtrasResult> {
  const session = await openZohoSession(companyId);
  const { rows } = await query<{ org_id: string; data_center: string }>(`SELECT org_id, data_center FROM zoho_config WHERE company_id=$1`, [companyId]);
  const apiBase = ZOHO_API[rows[0]?.data_center ?? 'IN'] || ZOHO_API.IN;
  const orgId = rows[0]?.org_id;

  const httpBinary = async (path: string, params: Record<string, unknown>): Promise<BinaryResponse> => {
    const res = await callZoho(companyId, (token) => axios.get<ArrayBuffer>(`${apiBase}${path}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: { organization_id: orgId, ...params },
      responseType: 'arraybuffer',
      timeout: 30_000,
      maxContentLength: 40 * 1024 * 1024,
    }));
    const contentType = String(res.headers['content-type'] ?? '') || null;
    const bytes = Buffer.from(res.data);
    // Zoho answers "no file" (and errors) as JSON, with a normal 200.
    if (contentType && /json/i.test(contentType)) {
      let body: unknown = null;
      try { body = JSON.parse(bytes.toString('utf8')); } catch { body = bytes.toString('utf8').slice(0, 200); }
      return { kind: 'json', body };
    }
    return { kind: 'file', bytes, contentType, fileName: fileNameFromDisposition(String(res.headers['content-disposition'] ?? '')) };
  };

  const deps: ExtrasDeps = {
    store: pgExtrasStore,
    http: session.http,
    httpBinary,
    now: () => Date.now(),
    sleep: (n) => new Promise((r) => setTimeout(r, n)),
    usage: { get: () => getZohoUsage(companyId), flush: () => flushZohoUsage(companyId), block: (until) => blockZohoUntil(companyId, until) },
  };
  return runExtrasSlice(companyId, deps, opts);
}
