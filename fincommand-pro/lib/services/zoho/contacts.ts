import axios from 'axios';
import { query } from '@/lib/db/neon';
import { ZOHO_API, callZoho, decryptZohoConfig, zohoErrorMessage, type ZohoConfigRow } from './client';

// ═══════════════════════════════════════════════════════════
//  Zoho Contacts — real customer & vendor MASTER data
// ═══════════════════════════════════════════════════════════

export interface ZohoContactSyncResult {
  synced: number;
  customers: number;
  vendors: number;
  errors: string[];
}

interface ExtractedContact {
  zoho_contact_id: string;
  contact_type: 'customer' | 'vendor';
  contact_name: string;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  gst_no: string | null;
  pan_no: string | null;
  gst_treatment: string | null;
  currency_code: string | null;
  payment_terms_label: string | null;
  status: string | null;
  outstanding_receivable_amount: number;
  outstanding_receivable_amount_bcy: number;
  outstanding_payable_amount: number;
  outstanding_payable_amount_bcy: number;
  zoho_created_at: string | null;
  zoho_last_modified_at: string | null;
}

/**
 * Field names confirmed against a real org's response (see the
 * zoho_debug_contacts_{customer,vendor}.json dumps this function writes on
 * its first page of each type) — not guessed. `billing_address` is
 * deliberately never populated: Zoho's LIST /contacts response (confirmed
 * against that same real dump) doesn't include it at all — only the
 * single-contact GET /contacts/{id} does, and calling that once per contact
 * would mean one extra Zoho API request per customer/vendor instead of one
 * request per 200 of them, working against the exact rate-limit-conscious
 * batching this whole sync engine is built around. Left NULL rather than
 * fetched at that cost or guessed at — same "honestly undetermined, never
 * fabricated" convention as tb-engine.ts's OCI/EPS/tax_paid.
 */
function extractContact(raw: Record<string, unknown>, contactType: 'customer' | 'vendor'): ExtractedContact | null {
  const id = raw.contact_id;
  const name = raw.contact_name ?? raw.customer_name ?? raw.vendor_name ?? raw.company_name;
  if (!id || !name) return null;
  const num = (v: unknown) => parseFloat(String(v ?? 0)) || 0;
  const str = (v: unknown) => (v != null && String(v).trim() ? String(v).trim() : null);
  return {
    zoho_contact_id: String(id),
    contact_type: contactType,
    contact_name: String(name).trim(),
    company_name: str(raw.company_name),
    email: str(raw.email),
    phone: str(raw.phone),
    mobile: str(raw.mobile),
    gst_no: str(raw.gst_no),
    pan_no: str(raw.pan_no),
    gst_treatment: str(raw.gst_treatment),
    currency_code: raw.currency_code ? String(raw.currency_code).toUpperCase() : null,
    payment_terms_label: str(raw.payment_terms_label),
    status: str(raw.status),
    outstanding_receivable_amount: num(raw.outstanding_receivable_amount),
    outstanding_receivable_amount_bcy: num(raw.outstanding_receivable_amount_bcy),
    outstanding_payable_amount: num(raw.outstanding_payable_amount),
    outstanding_payable_amount_bcy: num(raw.outstanding_payable_amount_bcy),
    zoho_created_at: str(raw.created_time),
    zoho_last_modified_at: str(raw.last_modified_time),
  };
}

/**
 * Pulls every real customer AND vendor contact record (not just the ones
 * with revenue/bill activity this year — the full live directory) and
 * upserts them into zoho_contacts. Callable on its own (e.g. a future
 * "refresh contacts" action) as well as from syncFromZoho() above.
 */
export async function syncZohoContacts(companyId: string): Promise<ZohoContactSyncResult> {
  const errors: string[] = [];
  const { rows: cfgRows } = await query<ZohoConfigRow>(
    `SELECT company_id, org_id, access_token, refresh_token, token_expiry, data_center FROM zoho_config WHERE company_id=$1 AND is_active=TRUE AND refresh_token IS NOT NULL`, [companyId]
  );
  if (!cfgRows.length) { errors.push('Zoho Books not connected'); return { synced: 0, customers: 0, vendors: 0, errors }; }
  const cfg = decryptZohoConfig(cfgRows[0]!);
  const orgId = cfg.org_id;
  if (!orgId) { errors.push('Zoho Organisation ID not set'); return { synced: 0, customers: 0, vendors: 0, errors }; }
  const apiBase = ZOHO_API[cfg.data_center] || ZOHO_API.IN;

  async function fetchAllContacts(contactType: 'customer' | 'vendor'): Promise<Record<string, unknown>[]> {
    const all: Record<string, unknown>[] = [];
    let page = 1;
    for (;;) {
      const res = await callZoho(companyId, (token) => axios.get(`${apiBase}/contacts`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params: { organization_id: orgId, contact_type: contactType, per_page: 200, page },
        timeout: 20000,
      }), 2, cfg);
      const items = Array.isArray(res.data?.contacts) ? res.data.contacts as Record<string, unknown>[] : [];
      all.push(...items);
      if (!res.data?.page_context?.has_more_page) break;
      page++;
    }
    return all;
  }

  let customerRaw: Record<string, unknown>[] = [];
  let vendorRaw: Record<string, unknown>[] = [];
  const [custRes, vendRes] = await Promise.allSettled([
    fetchAllContacts('customer'),
    fetchAllContacts('vendor')
  ]);
  if (custRes.status === 'fulfilled') customerRaw = custRes.value;
  else errors.push(`Customers: ${zohoErrorMessage(custRes.reason)}`);

  if (vendRes.status === 'fulfilled') vendorRaw = vendRes.value;
  else errors.push(`Vendors: ${zohoErrorMessage(vendRes.reason)}`);

  const extracted = [
    ...customerRaw.map((r) => extractContact(r, 'customer')),
    ...vendorRaw.map((r) => extractContact(r, 'vendor')),
  ].filter((c): c is ExtractedContact => c !== null);

  if (extracted.length === 0) {
    return { synced: 0, customers: customerRaw.length, vendors: vendorRaw.length, errors };
  }

  const chunkSize = 50;
  for (let i = 0; i < extracted.length; i += chunkSize) {
    const chunk = extracted.slice(i, i + chunkSize);
    const valueClauses: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;
    for (const c of chunk) {
      const row = [
        companyId, c.zoho_contact_id, c.contact_type, c.contact_name, c.company_name,
        c.email, c.phone, c.mobile, c.gst_no, c.pan_no, c.gst_treatment, c.currency_code,
        c.payment_terms_label, c.status,
        c.outstanding_receivable_amount, c.outstanding_receivable_amount_bcy,
        c.outstanding_payable_amount, c.outstanding_payable_amount_bcy,
        c.zoho_created_at, c.zoho_last_modified_at,
      ];
      const placeholders = row.map(() => `$${paramIdx++}`);
      valueClauses.push(`(${placeholders.join(',')})`);
      params.push(...row);
    }
    try {
      await query(
        `INSERT INTO zoho_contacts
          (company_id, zoho_contact_id, contact_type, contact_name, company_name,
           email, phone, mobile, gst_no, pan_no, gst_treatment, currency_code,
           payment_terms_label, status,
           outstanding_receivable_amount, outstanding_receivable_amount_bcy,
           outstanding_payable_amount, outstanding_payable_amount_bcy,
           zoho_created_at, zoho_last_modified_at)
         VALUES ${valueClauses.join(', ')}
         ON CONFLICT (company_id, zoho_contact_id) DO UPDATE SET
           contact_type=EXCLUDED.contact_type, contact_name=EXCLUDED.contact_name, company_name=EXCLUDED.company_name,
           email=EXCLUDED.email, phone=EXCLUDED.phone, mobile=EXCLUDED.mobile,
           gst_no=EXCLUDED.gst_no, pan_no=EXCLUDED.pan_no, gst_treatment=EXCLUDED.gst_treatment,
           currency_code=EXCLUDED.currency_code, payment_terms_label=EXCLUDED.payment_terms_label, status=EXCLUDED.status,
           outstanding_receivable_amount=EXCLUDED.outstanding_receivable_amount,
           outstanding_receivable_amount_bcy=EXCLUDED.outstanding_receivable_amount_bcy,
           outstanding_payable_amount=EXCLUDED.outstanding_payable_amount,
           outstanding_payable_amount_bcy=EXCLUDED.outstanding_payable_amount_bcy,
           zoho_created_at=EXCLUDED.zoho_created_at, zoho_last_modified_at=EXCLUDED.zoho_last_modified_at,
           synced_at=NOW()`,
        params
      );
    } catch (e) {
      errors.push(`Batch upsert failed: ${(e as Error).message}`);
    }
  }

  return { synced: extracted.length, customers: customerRaw.length, vendors: vendorRaw.length, errors };
}
