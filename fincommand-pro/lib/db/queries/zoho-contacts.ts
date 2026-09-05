import { query } from '@/lib/db/neon';

export interface ZohoContactRow {
  zoho_contact_id: string;
  contact_type: 'customer' | 'vendor';
  contact_name: string;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  gst_no: string | null;
  outstanding_receivable_amount_bcy: string | number;
  outstanding_payable_amount_bcy: string | number;
}

/**
 * Real synced contact directory (customers AND vendors) for a company —
 * live reference data, not scoped to any financial year or upload (see
 * zoho_contacts' own schema comment for why). Empty is a real, common state
 * — Excel-uploaded companies and any company that's never run a Zoho sync
 * since this feature shipped — not an error; callers must treat it as
 * "no contact enrichment available" and degrade gracefully, same
 * "does not exist" pre-migration fallback as loadCustomerRevenue().
 */
export async function loadZohoContacts(companyId: string): Promise<ZohoContactRow[]> {
  try {
    const { rows } = await query<ZohoContactRow>(
      `SELECT zoho_contact_id, contact_type, contact_name, email, phone, mobile, gst_no,
              outstanding_receivable_amount_bcy, outstanding_payable_amount_bcy
       FROM zoho_contacts WHERE company_id=$1 ORDER BY contact_name`,
      [companyId]
    );
    return rows;
  } catch (err) {
    if ((err as Error).message?.includes('does not exist')) return [];
    throw err;
  }
}
