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
    const { rows: fyRows } = await client.query<{ id: string; short_label: string; start_date: string }>(
      `SELECT id, short_label, start_date::text as start_date FROM financial_years WHERE company_id=$1`,
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
      // "First source owns the year" (migration 0001): seeded data is an Excel load.
      await client.query(`UPDATE financial_years SET data_source='excel' WHERE id=$1`, [fyRow.id]);
      for (const row of sampleRows) {
        const { rows: [insertedLedger] } = await client.query(
          `INSERT INTO tb_ledgers
            (upload_id, company_id, financial_year_id, ledger_code, ledger_name,
             note_no, note_name, section, treasury_type, normal_bal,
             op_dr, op_cr)
           VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING id`,
          [
            uploadId, companyId, fyRow.id, row.ledger_code, row.ledger_name,
            row.note_no, row.note_name, row.section, row.treasury_type, row.normal_bal,
            row.op_dr, row.op_cr,
          ]
        );
        const ledgerId = insertedLedger.id;
        const fyStart = new Date(fyRow.start_date);
        for (let i = 0; i < 12; i++) {
          const periodMonth = new Date(fyStart);
          periodMonth.setUTCMonth(periodMonth.getUTCMonth() + i, 1);
          const dr = (row as any)[`m${i + 1}_dr`] || 0;
          const cr = (row as any)[`m${i + 1}_cr`] || 0;
          await client.query(
            `INSERT INTO ledger_month_amounts (company_id, batch_id, ledger_id, period_month, dr, cr)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [companyId, uploadId, ledgerId, periodMonth.toISOString().slice(0, 10), dr, cr]
          );
        }
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

