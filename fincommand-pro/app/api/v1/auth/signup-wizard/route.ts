import type { NextRequest } from 'next/server';
import bcrypt from 'bcryptjs';
import { query, withTransaction } from '@/lib/db/neon';
import { signAccessToken, signRefreshToken } from '@/lib/auth/jwt';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { isEmail, isCIN, isPAN, isNotFutureDate, isStrongPassword, isIn, ValidationCollector } from '@/lib/validations/common';
import { isCurrencyCode } from '@/lib/services/currency';

export const runtime = 'nodejs';

// Roles a company admin may provision for teammates during onboarding.
// 'admin' is reserved for the Step 1 account — never assignable here, so a
// single company can never end up with two accounts racing for the same
// system-administrator seat via this endpoint.
const MEMBER_ROLES = ['cfo', 'ceo', 'auditor', 'manager', 'viewer'] as const;
const MAX_MEMBERS = 4;

interface MemberInput { name: string; email: string; password: string; role: string }

interface CreatedUserRow { id: string; name: string; email: string; role: string }

export const POST = withErrorHandling(async (req: NextRequest) => {
  const body = await req.json().catch(() => ({}));
  const adminIn = (body?.admin ?? {}) as Record<string, unknown>;
  const companyIn = (body?.company ?? {}) as Record<string, unknown>;
  const membersIn = Array.isArray(body?.members) ? (body.members as unknown[]) : [];

  const adminName = typeof adminIn.name === 'string' ? adminIn.name.trim() : '';
  const adminEmail = typeof adminIn.email === 'string' ? adminIn.email.trim().toLowerCase() : '';
  const adminPassword = typeof adminIn.password === 'string' ? adminIn.password : '';

  const companyName = typeof companyIn.name === 'string' ? companyIn.name.trim() : '';
  const cin = typeof companyIn.cin === 'string' ? companyIn.cin.trim().toUpperCase() : '';
  const dateOfIncorporation = typeof companyIn.date_of_incorporation === 'string' ? companyIn.date_of_incorporation : '';
  const panRaw = typeof companyIn.pan === 'string' ? companyIn.pan.trim().toUpperCase() : '';
  const gstinRaw = typeof companyIn.gstin === 'string' ? companyIn.gstin.trim().toUpperCase() : '';
  const registeredAddress = typeof companyIn.registered_address === 'string' ? companyIn.registered_address.trim() : '';
  // Source Currency (IAS 21 / IND AS 21) — defaults to 'INR' (matching the
  // companies.currency DB column's own default) when the signup form sends
  // nothing usable, rather than failing the whole signup over it.
  const currencyIn = typeof companyIn.currency === 'string' ? companyIn.currency.trim().toUpperCase() : '';
  const currency = isCurrencyCode(currencyIn) ? currencyIn : 'INR';
  // Default Presentation Currency — '' / missing / invalid all mean "same as
  // Source Currency" (NULL in the DB), never a hard validation failure.
  const presentationCurrencyIn = typeof companyIn.presentation_currency === 'string' ? companyIn.presentation_currency.trim().toUpperCase() : '';
  const presentationCurrency = isCurrencyCode(presentationCurrencyIn) ? presentationCurrencyIn : null;

  const v = new ValidationCollector()
    .check(adminName.length > 0, 'admin.name', 'Full name is required')
    .check(isEmail(adminEmail), 'admin.email', 'Invalid business email address')
    .check(isStrongPassword(adminPassword), 'admin.password', 'Password must be at least 8 characters and include a letter and a number')
    .check(companyName.length > 0, 'company.name', 'Company legal name is required')
    .check(isCIN(cin), 'company.cin', 'CIN must be a valid 21-character MCA registration number (e.g. U72900MH2015PTC123456)')
    .check(isNotFutureDate(dateOfIncorporation), 'company.date_of_incorporation', 'Date of incorporation is required and cannot be in the future')
    .check(panRaw === '' || isPAN(panRaw), 'company.pan', 'PAN must be a valid 10-character alphanumeric code')
    .check(registeredAddress.length <= 500, 'company.registered_address', 'Address must be 500 characters or fewer')
    .check(membersIn.length <= MAX_MEMBERS, 'members', `A maximum of ${MAX_MEMBERS} team members may be provisioned at signup`);

  const members: MemberInput[] = [];
  membersIn.slice(0, MAX_MEMBERS).forEach((raw, i) => {
    const m = (raw ?? {}) as Record<string, unknown>;
    const name = typeof m.name === 'string' ? m.name.trim() : '';
    const email = typeof m.email === 'string' ? m.email.trim().toLowerCase() : '';
    const password = typeof m.password === 'string' ? m.password : '';
    const role = typeof m.role === 'string' ? m.role : '';
    v.check(name.length > 0, `members[${i}].name`, 'Name is required')
      .check(isEmail(email), `members[${i}].email`, 'Invalid business email address')
      .check(isStrongPassword(password), `members[${i}].password`, 'Password must be at least 8 characters and include a letter and a number')
      .check(isIn(role, MEMBER_ROLES), `members[${i}].role`, `Role must be one of: ${MEMBER_ROLES.join(', ')}`);
    members.push({ name, email, password, role });
  });

  // Duplicate-email check across admin + all members, case-insensitive.
  const allEmails = [adminEmail, ...members.map(m => m.email)].filter(Boolean);
  const uniqueEmails = new Set(allEmails);
  v.check(uniqueEmails.size === allEmails.length, 'members', 'Each team member must have a unique email address');

  if (!v.isEmpty()) return json({ errors: v.errors() }, { status: 422 });

  // Parallel pre-checks for existing company and registered emails
  const [coRes, emailRes] = await Promise.all([
    query<{ id: string }>(
      `SELECT id FROM companies WHERE LOWER(name) = LOWER($1) AND date_of_incorporation = $2`,
      [companyName, dateOfIncorporation]
    ),
    query<{ email: string }>(
      `SELECT email FROM users WHERE email = ANY($1::text[])`,
      [allEmails]
    ),
  ]);

  if (coRes.rows.length > 0) {
    return json({ error: 'Company already created' }, { status: 409 });
  }
  if (emailRes.rows.length > 0) {
    return json(
      { error: 'Member is already added', emails: emailRes.rows.map(r => r.email) },
      { status: 409 }
    );
  }

  const rounds = parseInt(process.env.BCRYPT_ROUNDS || '10');

  // Pre-compute all password hashes concurrently BEFORE opening the DB transaction
  const [adminHash, memberHashes] = await Promise.all([
    bcrypt.hash(adminPassword, rounds),
    Promise.all(members.map(m => bcrypt.hash(m.password, rounds))),
  ]);

  let result;
  try {
    result = await withTransaction(async (client) => {
      const { rows: companyRows } = await client.query(
        `INSERT INTO companies (name, cin, pan, gstin, date_of_incorporation, registered_address, fiscal_year_start, currency, presentation_currency, reporting_standard)
         VALUES ($1,$2,$3,$4,$5,$6,4,$7,$8,'IND_AS') RETURNING *`,
        [companyName, cin, panRaw || null, gstinRaw || null, dateOfIncorporation, registeredAddress || null, currency, presentationCurrency]
      );
      const company = companyRows[0];

      const { rows: adminRows } = await client.query<CreatedUserRow>(
        `INSERT INTO users (company_id, name, email, password_hash, role, email_verified)
         VALUES ($1,$2,$3,$4,'admin',TRUE) RETURNING id, name, email, role`,
        [company.id, adminName, adminEmail, adminHash]
      );
      const adminUser = adminRows[0];

      const createdMembers: CreatedUserRow[] = [];
      for (let i = 0; i < members.length; i++) {
        const m = members[i];
        const hash = memberHashes[i];
        const { rows } = await client.query<CreatedUserRow>(
          `INSERT INTO users (company_id, name, email, password_hash, role, email_verified)
           VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING id, name, email, role`,
          [company.id, m.name, m.email, hash, m.role]
        );
        createdMembers.push(rows[0]);
      }

      await client.query(
        `INSERT INTO audit_trail (company_id, user_id, user_name, user_role, action, entity_type, entity_id, metadata)
         VALUES ($1,$2,$3,$4,'COMPANY_SIGNUP','company',$5,$6)`,
        [
          company.id, adminUser.id, adminUser.name, adminUser.role, company.id,
          JSON.stringify({ members_provisioned: createdMembers.length, roles: createdMembers.map(m => m.role) }),
        ]
      );

      return { company, adminUser, createdMembers };
    });
  } catch (err) {
    // Race-condition fallback: two concurrent signups picked the same email
    // between the pre-check above and this transaction.
    if ((err as { code?: string }).code === '23505') {
      return json({ error: 'One or more email addresses are already registered' }, { status: 409 });
    }
    throw err;
  }

  const { company, adminUser } = result;

  const accessToken = signAccessToken(adminUser.id, adminUser.role, company.id);
  const refreshToken = signRefreshToken(adminUser.id);
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
  const ua = req.headers.get('user-agent') || null;

  await query(
    `INSERT INTO refresh_tokens (user_id, token, ip_address, user_agent, expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [adminUser.id, refreshToken, ip, ua, expiresAt]
  );

  return json({
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: 900,
    user: {
      id: adminUser.id,
      name: adminUser.name,
      email: adminUser.email,
      role: adminUser.role,
      company_id: company.id,
      company_name: company.name,
    },
    company,
  }, { status: 201 });
});
