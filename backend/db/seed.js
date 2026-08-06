'use strict';
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

// const pool = new Pool({
//   host: process.env.DB_HOST || 'localhost',
//   port: parseInt(process.env.DB_PORT || '5432'),
//   database: process.env.DB_NAME || 'fincommand',
//   user: process.env.DB_USER || 'fincommand_user',
//   password: process.env.DB_PASSWORD,
// });
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'fincommand',
  user: process.env.DB_USER || 'fincommand_user',
  password: process.env.DB_PASSWORD,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function seed() {
  const client = await pool.connect();
  try {
    // 1. Create demo company
    const { rows: [company] } = await client.query(`
      INSERT INTO companies (name, cin, pan, registered_address, fiscal_year_start)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT DO NOTHING
      RETURNING id`,
      ['Acme Technologies Ltd', 'U72000MH2010PLC123456', 'AABCA1234Z',
        '501, Tech Park, BKC, Mumbai 400 051', 4]
    );
    const companyId = company?.id;
    if (!companyId) { console.log('Company already exists — skipping seed'); return; }
    console.log('✅ Company created:', companyId);

    // 2. Create financial years
    const fys = [
      { label: 'FY 2024-25', short: 'FY25', start: '2024-04-01', end: '2025-03-31' },
      { label: 'FY 2023-24', short: 'FY24', start: '2023-04-01', end: '2024-03-31' },
      { label: 'FY 2022-23', short: 'FY23', start: '2022-04-01', end: '2023-03-31' },
    ];
    const fyIds = {};
    for (const fy of fys) {
      const { rows: [row] } = await client.query(`
        INSERT INTO financial_years (company_id, label, short_label, start_date, end_date, year_type)
        VALUES ($1,$2,$3,$4,$5,'FY') RETURNING id`,
        [companyId, fy.label, fy.short, fy.start, fy.end]
      );
      fyIds[fy.short] = row.id;
    }
    console.log('✅ Financial years created');

    // 3. Create users
    const ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12');
    const users = [
      { name: 'Admin User', email: 'admin@acmetech.in', role: 'admin', pass: 'Admin@123' },
      { name: 'CFO — Ramesh', email: 'cfo@acmetech.in', role: 'cfo', pass: 'CFO@1234' },
      { name: 'CEO — Suresh', email: 'ceo@acmetech.in', role: 'ceo', pass: 'CEO@1234' },
      { name: 'Auditor', email: 'auditor@acmetech.in', role: 'auditor', pass: 'Audit@123' },
    ];
    for (const u of users) {
      const hash = await bcrypt.hash(u.pass, ROUNDS);
      await client.query(`
  INSERT INTO users (
    company_id,
    name,
    email,
    password_hash,
    role,
    email_verified
  )
  VALUES ($1,$2,$3,$4,$5,TRUE)
  ON CONFLICT (email) DO NOTHING`,
        [companyId, u.name, u.email, hash, u.role]
      );
    }
    console.log('✅ Users created');

    // 4. Copy global ledger master for this company
    await client.query(`
      INSERT INTO ledger_master
        (company_id, ledger_code, ledger_name, note_no, note_name,
         section, treasury_type, normal_bal, is_global)
      SELECT $1, ledger_code, ledger_name, note_no, note_name,
             section, treasury_type, normal_bal, FALSE
      FROM ledger_master WHERE company_id IS NULL
      ON CONFLICT DO NOTHING`,
      [companyId]
    );
    console.log('✅ Ledger Master copied for company');

    console.log('\n════════════════════════════════');
    console.log('  Demo credentials:');
    console.log('  admin@acmetech.in  / Admin@123');
    console.log('  cfo@acmetech.in    / CFO@1234');
    console.log('  ceo@acmetech.in    / CEO@1234');
    console.log('════════════════════════════════\n');
  } catch (err) {
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
