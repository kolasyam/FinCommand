/* eslint-disable no-console */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { Pool } from 'pg';
import { buildSampleLedgers, type SampleFyKey } from '../lib/financial/sample-data';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'fincommand',
  user: process.env.DB_USER || 'fincommand_user',
  password: process.env.DB_PASSWORD,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function seed() {
  const client = await pool.connect();
  try {
    let companyId: string | undefined;
    const { rows: existingCo } = await client.query(`SELECT id FROM companies WHERE name=$1`, ['Acme Technologies Ltd']);
    if (existingCo.length > 0) {
      companyId = existingCo[0].id;
      console.log('ℹ️ Company Acme Technologies Ltd already exists:', companyId);
    } else {
      const { rows: [company] } = await client.query(
        `INSERT INTO companies (name, cin, pan, registered_address, fiscal_year_start)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id`,
        ['Acme Technologies Ltd', 'U72000MH2010PLC123456', 'AABCA1234Z',
          '501, Tech Park, BKC, Mumbai 400 051', 4]
      );
      companyId = company?.id;
      console.log('✅ Company created:', companyId);
    }

    if (!companyId) throw new Error('Could not find or create company');

    const fys = [
      { label: 'FY 2024-25', short: 'FY25', start: '2024-04-01', end: '2025-03-31' },
      { label: 'FY 2023-24', short: 'FY24', start: '2023-04-01', end: '2024-03-31' },
      { label: 'FY 2022-23', short: 'FY23', start: '2022-04-01', end: '2023-03-31' },
    ];
    for (const fy of fys) {
      await client.query(
        `INSERT INTO financial_years (company_id, label, short_label, start_date, end_date, year_type)
         VALUES ($1,$2,$3,$4,$5,'FY')
         ON CONFLICT (company_id, label) DO NOTHING`,
        [companyId, fy.label, fy.short, fy.start, fy.end]
      );
    }
    console.log('✅ Financial years created');

    const ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12');
    const users = [
      { name: 'Admin User', email: 'admin@acmetech.in', role: 'admin', pass: 'Admin@123' },
      { name: 'CFO — Ramesh', email: 'cfo@acmetech.in', role: 'cfo', pass: 'CFO@1234' },
      { name: 'CEO — Suresh', email: 'ceo@acmetech.in', role: 'ceo', pass: 'CEO@1234' },
      { name: 'Auditor', email: 'auditor@acmetech.in', role: 'auditor', pass: 'Audit@123' },
    ];
    let adminUserId: string | null = null;
    for (const u of users) {
      const hash = await bcrypt.hash(u.pass, ROUNDS);
      const { rows: [uRow] } = await client.query(
        `INSERT INTO users (company_id, name, email, password_hash, role, email_verified)
         VALUES ($1,$2,$3,$4,$5,TRUE)
         ON CONFLICT (email) DO UPDATE SET company_id=EXCLUDED.company_id
         RETURNING id, role`,
        [companyId, u.name, u.email, hash, u.role]
      );
      if (uRow?.role === 'admin') adminUserId = uRow.id;
    }
    console.log('✅ Users created');

    await client.query(
      `INSERT INTO ledger_master
        (company_id, ledger_code, ledger_name, note_no, note_name,
         section, treasury_type, normal_bal, is_global)
       SELECT $1, ledger_code, ledger_name, note_no, note_name,
              section, treasury_type, normal_bal, FALSE
       FROM ledger_master WHERE company_id IS NULL
       ON CONFLICT DO NOTHING`,
      [companyId]
    );
    console.log('✅ Ledger Master copied for company');

    // Seed Trial Balance uploads & ledgers for each FY if not present
    const { rows: fyRows } = await client.query<{ id: string; short_label: string }>(
      `SELECT id, short_label FROM financial_years WHERE company_id=$1`,
      [companyId]
    );

    for (const fyRow of fyRows) {
      const fyKey = fyRow.short_label as SampleFyKey;
      if (!['FY25', 'FY24', 'FY23'].includes(fyKey)) continue;

      const { rows: existingUploads } = await client.query(
        `SELECT id FROM tb_uploads WHERE company_id=$1 AND financial_year_id=$2 AND status='complete'`,
        [companyId, fyRow.id]
      );

      if (existingUploads.length > 0) continue;

      const sampleRows = buildSampleLedgers(fyKey);
      const { rows: [upload] } = await client.query(
        `INSERT INTO tb_uploads
          (company_id, financial_year_id, uploaded_by, source, filename, ledger_count, mapped_count, status, is_current)
         VALUES ($1, $2, $3, 'excel', 'seed_trial_balance.xlsx', $4, $4, 'complete', TRUE)
         RETURNING id`,
        [companyId, fyRow.id, adminUserId, sampleRows.length]
      );

      const uploadId = upload.id;
      for (const row of sampleRows) {
        await client.query(
          `INSERT INTO tb_ledgers
            (upload_id, company_id, financial_year_id, ledger_code, ledger_name,
             note_no, note_name, section, treasury_type, normal_bal,
             op_dr, op_cr,
             m1_dr, m1_cr, m2_dr, m2_cr, m3_dr, m3_cr, m4_dr, m4_cr,
             m5_dr, m5_cr, m6_dr, m6_cr, m7_dr, m7_cr, m8_dr, m8_cr,
             m9_dr, m9_cr, m10_dr, m10_cr, m11_dr, m11_cr, m12_dr, m12_cr)
           VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
             $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36)`,
          [
            uploadId, companyId, fyRow.id, row.ledger_code, row.ledger_name,
            row.note_no, row.note_name, row.section, row.treasury_type, row.normal_bal,
            row.op_dr, row.op_cr,
            row.m1_dr, row.m1_cr, row.m2_dr, row.m2_cr, row.m3_dr, row.m3_cr, row.m4_dr, row.m4_cr,
            row.m5_dr, row.m5_cr, row.m6_dr, row.m6_cr, row.m7_dr, row.m7_cr, row.m8_dr, row.m8_cr,
            row.m9_dr, row.m9_cr, row.m10_dr, row.m10_cr, row.m11_dr, row.m11_cr, row.m12_dr, row.m12_cr,
          ]
        );
      }
    }
    console.log('✅ Trial Balance seed ledgers populated for company');

    console.log('\n════════════════════════════════');
    console.log('  Demo credentials:');
    console.log('  admin@acmetech.in  / Admin@123');
    console.log('  cfo@acmetech.in    / CFO@1234');
    console.log('  ceo@acmetech.in    / CEO@1234');
    console.log('════════════════════════════════\n');
  } catch (err) {
    console.error('❌ Seed failed:', (err as Error).message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();

