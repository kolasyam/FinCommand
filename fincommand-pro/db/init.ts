/* eslint-disable no-console */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'fincommand',
  user: process.env.DB_USER || 'fincommand_user',
  password: process.env.DB_PASSWORD,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// ── 90+ pre-seeded IND AS Schedule III ledger mappings ──
// [code, name, note_no, note_name, section, treasury_type, normal_bal]
// Ported verbatim from backend/db/init.js — do not reorder/renumber notes.
const LEDGER_MASTER_SEED: [string, string, number, string, string, string | null, string][] = [
  // PPE
  ['1001','Plant & Machinery',10,'PPE','anc',null,'Dr'],
  ['1002','Furniture & Fixtures',10,'PPE','anc',null,'Dr'],
  ['1003','Computers & Peripherals',10,'PPE','anc',null,'Dr'],
  ['1004','Vehicles',10,'PPE','anc',null,'Dr'],
  ['1005','Office Equipment',10,'PPE','anc',null,'Dr'],
  ['1006','Accumulated Depreciation — PPE',10,'PPE','anc',null,'Cr'],
  ['1007','Capital Work-in-Progress',10,'PPE','anc',null,'Dr'],
  // ROU
  ['1011','Right-of-Use Asset — Office',11,'ROU Assets','anc',null,'Dr'],
  ['1012','Accumulated Depreciation — ROU',11,'ROU Assets','anc',null,'Cr'],
  // Intangibles
  ['1021','Computer Software (Purchased)',12,'Intangibles','anc',null,'Dr'],
  ['1022','Internally Developed Software',12,'Intangibles','anc',null,'Dr'],
  ['1023','Amortisation — Intangibles',12,'Intangibles','anc',null,'Cr'],
  // Investments NC
  ['1031','Investment in Subsidiaries',13,'Investments NC','anc',null,'Dr'],
  ['1032','Investment in Associates',13,'Investments NC','anc',null,'Dr'],
  // Investments Current (MF)
  ['1033','HDFC Liquid Fund',13,'Investments Current','ac','mf','Dr'],
  ['1034','ICICI Pru Money Market Fund',13,'Investments Current','ac','mf','Dr'],
  ['1035','SBI Liquid Fund',13,'Investments Current','ac','mf','Dr'],
  ['1036','Axis Liquid Fund',13,'Investments Current','ac','mf','Dr'],
  // Other NC Assets
  ['1041','Security Deposit (NC)',14,'Other NC Assets','anc',null,'Dr'],
  ['1042','Advance Tax (NC)',14,'Other NC Assets','anc',null,'Dr'],
  ['1043','MAT Credit Entitlement',14,'Other NC Assets','anc',null,'Dr'],
  // Inventories
  ['1051','Traded Goods / Stock-in-Trade',15,'Inventories','ac',null,'Dr'],
  ['1052','Work-in-Progress',15,'Inventories','ac',null,'Dr'],
  ['1053','Raw Materials',15,'Inventories','ac',null,'Dr'],
  // Trade Receivables
  ['1061','Sundry Debtors < 6 months',16,'Trade Receivables','ac',null,'Dr'],
  ['1062','Sundry Debtors > 6 months',16,'Trade Receivables','ac',null,'Dr'],
  ['1063','Provision for Bad Debts (ECL)',16,'Trade Receivables','ac',null,'Cr'],
  // Cash & CE (Note 19 in our BS)
  ['2001','Cash in Hand',19,'Cash & CE','ac','cash','Dr'],
  ['2002','Petty Cash',19,'Cash & CE','ac','cash','Dr'],
  ['2101','HDFC Bank — Current Account',19,'Cash & CE','ac','bank_ca','Dr'],
  ['2102','ICICI Bank — Current Account',19,'Cash & CE','ac','bank_ca','Dr'],
  ['2103','SBI — Current Account',19,'Cash & CE','ac','bank_ca','Dr'],
  ['2104','Axis Bank — Current Account',19,'Cash & CE','ac','bank_ca','Dr'],
  ['2105','Kotak Bank — Current Account',19,'Cash & CE','ac','bank_ca','Dr'],
  ['2201','Kotak Bank — Savings / Sweep',19,'Cash & CE','ac','bank_sb','Dr'],
  ['2202','HDFC Bank — Savings Account',19,'Cash & CE','ac','bank_sb','Dr'],
  // FDs (Note 20 — Bank Balances other than CE)
  ['2301','HDFC Fixed Deposit — 001',20,'Bank Balances (FDs)','ac','fd','Dr'],
  ['2302','ICICI Fixed Deposit — 002',20,'Bank Balances (FDs)','ac','fd','Dr'],
  ['2303','SBI Fixed Deposit — 003',20,'Bank Balances (FDs)','ac','fd','Dr'],
  ['2304','Axis Fixed Deposit — 001',20,'Bank Balances (FDs)','ac','fd','Dr'],
  ['2305','HDFC Margin Money FD',20,'Bank Balances (FDs)','ac','fd','Dr'],
  // Loans & Advances
  ['1071','Staff Advance (Current)',21,'Loans & Advances','ac',null,'Dr'],
  ['1072','Security Deposit (Current)',21,'Loans & Advances','ac',null,'Dr'],
  ['1073','Prepaid Expenses',21,'Loans & Advances','ac',null,'Dr'],
  // Other Current Assets
  ['1081','GST Input Tax Credit Receivable',23,'Other Current Assets','ac',null,'Dr'],
  ['1082','TDS Receivable',23,'Other Current Assets','ac',null,'Dr'],
  ['1083','Advance to Suppliers',23,'Other Current Assets','ac',null,'Dr'],
  ['1084','Unbilled Revenue / Contract Asset',23,'Other Current Assets','ac',null,'Dr'],
  // Equity
  ['3001','Equity Share Capital',1,'Share Capital','eq',null,'Cr'],
  ['3011','Securities Premium Reserve',2,'Other Equity','eq',null,'Cr'],
  ['3012','General Reserve',2,'Other Equity','eq',null,'Cr'],
  ['3013','Retained Earnings',2,'Other Equity','eq',null,'Cr'],
  ['3014','ESOP Reserve',2,'Other Equity','eq',null,'Cr'],
  ['3015','OCI — Remeasurement of DBO',2,'Other Equity','eq',null,'Dr'],
  // NC Liabilities
  ['4001','Term Loan — HDFC Bank',3,'Long-Term Borrowings','lnc',null,'Cr'],
  ['4002','Term Loan — SBI',3,'Long-Term Borrowings','lnc',null,'Cr'],
  ['4003','Term Loan — ICICI Bank',3,'Long-Term Borrowings','lnc',null,'Cr'],
  ['4011','Lease Liability — Long Term (IND AS 116)',4,'Lease Liabilities','lnc',null,'Cr'],
  ['4021','Deferred Tax Liability',5,'Deferred Tax','lnc',null,'Cr'],
  ['4022','Deferred Tax Asset',5,'Deferred Tax','lnc',null,'Dr'],
  ['4031','Gratuity Liability (IND AS 19)',6,'Long-Term Provisions','lnc',null,'Cr'],
  ['4032','Leave Encashment Liability (NC)',6,'Long-Term Provisions','lnc',null,'Cr'],
  // Current Liabilities
  ['5001','MSME Trade Creditors',7,'Trade Payables','lc',null,'Cr'],
  ['5002','Other Trade Creditors',7,'Trade Payables','lc',null,'Cr'],
  ['5011','Accrued Salaries & Benefits',8,'Other Financial Liabilities','lc',null,'Cr'],
  ['5012','Accrued Expenses',8,'Other Financial Liabilities','lc',null,'Cr'],
  ['5013','Customer Deposit / Retention',8,'Other Financial Liabilities','lc',null,'Cr'],
  ['5014','Lease Liability — Current (IND AS 116)',8,'Other Financial Liabilities','lc',null,'Cr'],
  ['5021','OD / Working Capital Loan — HDFC',9,'ST Borrowings','lc',null,'Cr'],
  ['5022','Working Capital Loan — SBI',9,'ST Borrowings','lc',null,'Cr'],
  ['5031','Advance from Customers',17,'Other Current Liabilities','lc',null,'Cr'],
  ['5032','Statutory Dues Payable (PF, ESIC)',17,'Other Current Liabilities','lc',null,'Cr'],
  ['5033','TDS Payable',17,'Other Current Liabilities','lc',null,'Cr'],
  ['5034','GST Payable',17,'Other Current Liabilities','lc',null,'Cr'],
  ['5035','Current Tax Payable',17,'Other Current Liabilities','lc',null,'Cr'],
  ['5041','Provision for Employee Benefits (ST)',18,'Short-Term Provisions','lc',null,'Cr'],
  ['5042','Provision for Expenses / Tax (ST)',18,'Short-Term Provisions','lc',null,'Cr'],
  // Revenue
  ['6001','IT Services Revenue',20,'Revenue from Operations','inc',null,'Cr'],
  ['6002','Managed Services / AMC Revenue',20,'Revenue from Operations','inc',null,'Cr'],
  ['6003','Product / Resale Revenue',20,'Revenue from Operations','inc',null,'Cr'],
  ['6004','SaaS Subscription Revenue',20,'Revenue from Operations','inc',null,'Cr'],
  ['6005','Consulting Revenue',20,'Revenue from Operations','inc',null,'Cr'],
  // Other Income
  ['6011','Interest on Fixed Deposits',21,'Other Income','inc',null,'Cr'],
  ['6012','Dividend from Mutual Funds',21,'Other Income','inc',null,'Cr'],
  ['6013','Profit on Sale of Investments',21,'Other Income','inc',null,'Cr'],
  ['6014','Miscellaneous Income',21,'Other Income','inc',null,'Cr'],
  ['6015','Foreign Exchange Gain',21,'Other Income','inc',null,'Cr'],
  // Cost of Services
  ['7001','Subcontracting Charges',22,'Cost of Services','exp',null,'Dr'],
  ['7002','Cloud & Infrastructure Costs',22,'Cost of Services','exp',null,'Dr'],
  ['7003','Software Licences (Direct)',22,'Cost of Services','exp',null,'Dr'],
  ['7004','Technical Consumables',22,'Cost of Services','exp',null,'Dr'],
  ['7005','Data Centre Costs',22,'Cost of Services','exp',null,'Dr'],
  // Employee Benefits
  ['7011','Salaries & Wages',23,'Employee Benefits','exp',null,'Dr'],
  ['7012','Bonus & Incentives',23,'Employee Benefits','exp',null,'Dr'],
  ['7013','PF Contribution (Employer)',23,'Employee Benefits','exp',null,'Dr'],
  ['7014','ESIC Contribution',23,'Employee Benefits','exp',null,'Dr'],
  ['7015','Gratuity Expense (IND AS 19)',23,'Employee Benefits','exp',null,'Dr'],
  ['7016','ESOP Charge (IND AS 102)',23,'Employee Benefits','exp',null,'Dr'],
  ['7017','Staff Welfare & Training',23,'Employee Benefits','exp',null,'Dr'],
  ['7018','Leave Encashment Expense',23,'Employee Benefits','exp',null,'Dr'],
  // Finance Costs
  ['7021','Interest on Term Loans',24,'Finance Costs','exp',null,'Dr'],
  ['7022','Interest on Lease Liabilities',24,'Finance Costs','exp',null,'Dr'],
  ['7023','Bank Charges & Processing Fees',24,'Finance Costs','exp',null,'Dr'],
  ['7024','Foreign Exchange Loss',24,'Finance Costs','exp',null,'Dr'],
  // Depreciation
  ['7031','Depreciation on PPE (IND AS 16)',25,'Depreciation & Amort.','exp',null,'Dr'],
  ['7032','Amortisation — Intangibles',25,'Depreciation & Amort.','exp',null,'Dr'],
  ['7033','Depreciation on ROU Assets',25,'Depreciation & Amort.','exp',null,'Dr'],
  // Other Expenses
  ['7041','Rent & Utilities',26,'Other Expenses','exp',null,'Dr'],
  ['7042','Marketing & Business Development',26,'Other Expenses','exp',null,'Dr'],
  ['7043','Professional & Legal Fees',26,'Other Expenses','exp',null,'Dr'],
  ['7044','Travel & Conveyance',26,'Other Expenses','exp',null,'Dr'],
  ['7045','Admin & Office Expenses',26,'Other Expenses','exp',null,'Dr'],
  ['7046','Insurance Premium',26,'Other Expenses','exp',null,'Dr'],
  ['7047','Communication & Internet',26,'Other Expenses','exp',null,'Dr'],
  ['7048','CSR Expenditure',26,'Other Expenses','exp',null,'Dr'],
];

async function init() {
  const client = await pool.connect();
  const reset = process.argv.includes('--reset');
  try {
    if (reset) {
      console.log('⚠  Dropping existing schema...');
      await client.query(`
        DROP TABLE IF EXISTS audit_trail, sync_logs, zoho_config,
          ledger_master, tb_ledgers, tb_uploads, financial_years,
          refresh_tokens, users, companies CASCADE;
        DROP FUNCTION IF EXISTS update_updated_at CASCADE;
      `);
      console.log('✅ Schema dropped');
    }

    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await client.query(sql);
    console.log('✅ Schema created');

    // Run Note 17 & Note 18 migration update and column migrations
    await client.query(`
      ALTER TABLE tb_uploads ADD COLUMN IF NOT EXISTS raw_zoho_months JSONB;
      ALTER TABLE tb_ledgers ADD COLUMN IF NOT EXISTS zoho_account_id VARCHAR(100);
      ALTER TABLE tb_ledgers ADD COLUMN IF NOT EXISTS zoho_account_type VARCHAR(50);
      ALTER TABLE tb_ledgers ADD COLUMN IF NOT EXISTS depth INTEGER DEFAULT 0;
      ALTER TABLE tb_ledgers ADD COLUMN IF NOT EXISTS is_child_present BOOLEAN DEFAULT FALSE;
      UPDATE ledger_master SET note_no=17, note_name='Other Current Liabilities', section='lc' WHERE ledger_code IN ('5031','5032','5033','5034','5035');
      UPDATE ledger_master SET note_no=18, note_name='Short-Term Provisions', section='lc' WHERE ledger_code IN ('5041','5042');
      UPDATE tb_ledgers SET note_no=17, note_name='Other Current Liabilities', section='lc' WHERE ledger_code IN ('5031','5032','5033','5034','5035');
      UPDATE tb_ledgers SET note_no=18, note_name='Short-Term Provisions', section='lc' WHERE ledger_code IN ('5041','5042');
    `);

    console.log(`⏳ Seeding ${LEDGER_MASTER_SEED.length} ledger mappings...`);
    for (const row of LEDGER_MASTER_SEED) {
      await client.query(
        `INSERT INTO ledger_master
          (company_id, ledger_code, ledger_name, note_no, note_name,
           section, treasury_type, normal_bal, is_global)
         VALUES (NULL,$1,$2,$3,$4,$5,$6,$7,TRUE)
         ON CONFLICT (company_id, ledger_code) DO UPDATE SET
           note_no = EXCLUDED.note_no,
           note_name = EXCLUDED.note_name,
           section = EXCLUDED.section,
           normal_bal = EXCLUDED.normal_bal`,
        [row[0], row[1], row[2], row[3], row[4], row[5] || null, row[6]]
      );
    }
    console.log('✅ Ledger Master seeded');
    console.log('\n✅ Database initialised successfully');
    console.log('   Run: npm run db:seed to create a demo company + admin user');
  } catch (err) {
    console.error('❌ Init failed:', (err as Error).message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

init();
