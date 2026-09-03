import type { NextRequest } from 'next/server';
import { authenticate, requireRole, ROLE_SETS } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { query } from '@/lib/db/neon';

import { isCIN, isPAN, isNotFutureDate, ValidationCollector } from '@/lib/validations/common';
import { isCurrencyCode } from '@/lib/services/currency';

export const runtime = 'nodejs';

export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  const { rows } = await query('SELECT * FROM companies WHERE id=$1', [user.company_id]);
  return json(rows[0]);
});

export const PUT = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticate(req);
  requireRole(user, ROLE_SETS.isAdmin);

  const body = await req.json().catch(() => ({}));
  const { name, cin, date_of_incorporation, pan, gstin, registered_address, currency, presentation_currency } = body;

  const v = new ValidationCollector();
  if (name !== undefined) v.check(name.trim().length > 0, 'name', 'Company legal name is required');
  if (cin !== undefined) v.check(isCIN(cin), 'cin', 'CIN must be a valid 21-character MCA registration number');
  if (date_of_incorporation !== undefined) v.check(isNotFutureDate(date_of_incorporation) && date_of_incorporation !== '', 'date_of_incorporation', 'Date of incorporation cannot be in the future');
  if (pan !== undefined && pan.trim() !== '') v.check(isPAN(pan), 'pan', 'PAN must be a valid 10-character alphanumeric code');
  if (registered_address !== undefined) v.check(registered_address.length <= 500, 'registered_address', 'Address must be 500 characters or fewer');
  // Source Currency (IAS 21 / IND AS 21) — never null; for a Zoho-connected
  // company this is normally auto-detected instead (see
  // fetchAndStoreZohoOrgCurrency()), but an admin can still correct it here.
  if (currency !== undefined) v.check(isCurrencyCode(String(currency).toUpperCase()), 'currency', 'Source Currency must be one of INR, USD, EUR, GBP, AED');
  // Presentation Currency default: '' means "same as Source Currency" (NULL
  // in the DB) — the only state that needs no FX conversion — distinct from
  // omitting the field entirely (leave the saved default unchanged).
  if (presentation_currency !== undefined && presentation_currency !== '') {
    v.check(isCurrencyCode(String(presentation_currency).toUpperCase()), 'presentation_currency', 'Presentation Currency must be one of INR, USD, EUR, GBP, AED');
  }

  if (!v.isEmpty()) return json({ errors: v.errors() }, { status: 422 });

  const { rows } = await query(
    `UPDATE companies
     SET name = COALESCE($1, name),
         cin = COALESCE($2, cin),
         pan = CASE WHEN $3 = 'DEFAULT' THEN pan ELSE $3 END,
         gstin = CASE WHEN $4 = 'DEFAULT' THEN gstin ELSE $4 END,
         registered_address = CASE WHEN $5 = 'DEFAULT' THEN registered_address ELSE $5 END,
         date_of_incorporation = COALESCE($6, date_of_incorporation),
         currency = COALESCE($7, currency),
         presentation_currency = CASE WHEN $8 = 'DEFAULT' THEN presentation_currency ELSE $8 END,
         updated_at = NOW()
     WHERE id = $9 RETURNING *`,
    [
      name !== undefined ? name.trim() : null,
      cin !== undefined ? cin.trim().toUpperCase() : null,
      pan !== undefined ? (pan.trim() ? pan.trim().toUpperCase() : null) : 'DEFAULT',
      gstin !== undefined ? (gstin.trim() ? gstin.trim().toUpperCase() : null) : 'DEFAULT',
      registered_address !== undefined ? (registered_address.trim() ? registered_address.trim() : null) : 'DEFAULT',
      date_of_incorporation !== undefined && date_of_incorporation !== '' ? date_of_incorporation : null,
      currency !== undefined ? String(currency).toUpperCase() : null,
      presentation_currency !== undefined ? (presentation_currency === '' ? null : String(presentation_currency).toUpperCase()) : 'DEFAULT',
      user.company_id
    ]
  );
  return json(rows[0]);
});
