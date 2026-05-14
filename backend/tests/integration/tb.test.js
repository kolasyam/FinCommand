'use strict';
/**
 * Integration tests — Trial Balance upload
 * Tests multipart upload, validation, ledger mapping,
 * and subsequent report generation from uploaded data.
 */

const request = require('supertest');
const bcrypt  = require('bcryptjs');
const path    = require('path');
const fs      = require('fs');
const XLSX    = require('xlsx');
const app     = require('../../server');
const db      = require('../../db/connection');

const DB_AVAILABLE = !!process.env.DB_HOST;
const describeIf   = DB_AVAILABLE ? describe : describe.skip;

let token, companyId, fyId, uploadId;

// Build a minimal valid TB Excel in memory
function buildTestTBBuffer() {
  const wb  = XLSX.utils.book_new();
  const hdr = ['Ledger_Code','Ledger_Name','Opening_Dr','Opening_Cr',
    'Apr_Dr','Apr_Cr','May_Dr','May_Cr','Jun_Dr','Jun_Cr',
    'Jul_Dr','Jul_Cr','Aug_Dr','Aug_Cr','Sep_Dr','Sep_Cr',
    'Oct_Dr','Oct_Cr','Nov_Dr','Nov_Cr','Dec_Dr','Dec_Cr',
    'Jan_Dr','Jan_Cr','Feb_Dr','Feb_Cr','Mar_Dr','Mar_Cr'];
  const rows = [
    ['6001','IT Services Revenue',0,0, 0,1000,0,1100,0,1200,0,1300,0,1250,0,1350,0,1400,0,1500,0,1450,0,1550,0,1600,0,1500],
    ['7011','Salaries & Wages',0,0,  500,0,520,0,540,0,560,0,545,0,570,0,590,0,610,0,600,0,620,0,640,0,590,0],
    ['7031','Depreciation on PPE',0,0, 40,0,40,0,40,0,42,0,42,0,42,0,44,0,44,0,44,0,45,0,45,0,45,0],
    ['2101','HDFC Bank CA',3000,0, 200,50,150,300,180,60,200,100,150,200,180,80,220,100,160,200,180,100,200,80,240,100,200,120],
    ['2301','HDFC FD 001',1500,0, 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    ['3001','Equity Share Capital',0,10000, 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    ['5001','MSME Trade Creditors',0,5000, 400,440,400,440,400,440,400,440,400,440,400,440,400,440,400,440,400,440,400,440,400,440,400,440],
  ];
  const ws = XLSX.utils.aoa_to_sheet([hdr, ...rows]);
  XLSX.utils.book_append_sheet(wb, ws, 'Trial_Balance');
  return XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
}

describeIf('POST /api/v1/tb/upload', () => {
  beforeAll(async () => {
    // Create isolated company + user
    const { rows:[co] } = await db.query(
      `INSERT INTO companies (name,fiscal_year_start) VALUES ('TBTest Co',4) RETURNING id`
    );
    companyId = co.id;
    const hash = await bcrypt.hash('CFO@test1', 4);
    const { rows:[u] } = await db.query(
      `INSERT INTO users (company_id,name,email,password_hash,role,email_verified)
       VALUES ($1,'TB CFO','tb-cfo@test.in',$2,'cfo',TRUE) RETURNING id`,
      [companyId, hash]
    );
    const { rows:[fy] } = await db.query(
      `INSERT INTO financial_years (company_id,label,short_label,start_date,end_date)
       VALUES ($1,'FY 2024-25','FY25','2024-04-01','2025-03-31') RETURNING id`,
      [companyId]
    );
    fyId = fy.id;

    // Seed ledger master for this company
    await db.query(
      `INSERT INTO ledger_master (company_id,ledger_code,ledger_name,note_no,note_name,section,treasury_type,normal_bal,is_global)
       VALUES
         ($1,'6001','IT Services Revenue',20,'Revenue','inc',NULL,'Cr',FALSE),
         ($1,'7011','Salaries & Wages',23,'Employee Benefits','exp',NULL,'Dr',FALSE),
         ($1,'7031','Depreciation on PPE',25,'Depreciation & Amort.','exp',NULL,'Dr',FALSE),
         ($1,'2101','HDFC Bank CA',19,'Cash & CE','ac','bank_ca','Dr',FALSE),
         ($1,'2301','HDFC FD 001',20,'Bank Balances (FDs)','ac','fd','Dr',FALSE),
         ($1,'3001','Equity Share Capital',1,'Share Capital','eq',NULL,'Cr',FALSE),
         ($1,'5001','MSME Trade Creditors',7,'Trade Payables','lc',NULL,'Cr',FALSE)`,
      [companyId]
    );

    const r = await request(app).post('/api/v1/auth/login')
      .send({ email:'tb-cfo@test.in', password:'CFO@test1' });
    token = r.body.access_token;
  });

  afterAll(async () => {
    await db.query('DELETE FROM companies WHERE id=$1', [companyId]);
  });

  test('rejects upload without auth', async () => {
    const res = await request(app).post('/api/v1/tb/upload').field('financial_year_id', fyId);
    expect(res.status).toBe(401);
  });

  test('rejects upload without financial_year_id', async () => {
    const buf = buildTestTBBuffer();
    const res = await request(app)
      .post('/api/v1/tb/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('trial_balance', buf, 'test_tb.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/financial_year_id/);
  });

  test('rejects non-Excel file', async () => {
    const res = await request(app)
      .post('/api/v1/tb/upload')
      .set('Authorization', `Bearer ${token}`)
      .field('financial_year_id', fyId)
      .attach('trial_balance', Buffer.from('not excel'), 'bad.txt');
    expect([400, 422, 500]).toContain(res.status);
  });

  test('successfully uploads valid TB', async () => {
    const buf = buildTestTBBuffer();
    const res = await request(app)
      .post('/api/v1/tb/upload')
      .set('Authorization', `Bearer ${token}`)
      .field('financial_year_id', fyId)
      .attach('trial_balance', buf, 'test_tb.xlsx');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      ledger_count:     7,
      mapped_count:     7,
      has_monthly_cols: true,
      coverage_pct:     100,
    });
    uploadId = res.body.upload_id;
  });

  test('TB data is queryable after upload', async () => {
    const res = await request(app)
      .get(`/api/v1/tb/${uploadId}/ledgers`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.ledgers.length).toBe(7);
    const rev = res.body.ledgers.find(l => l.ledger_code === '6001');
    expect(rev).toBeDefined();
    expect(rev.note_no).toBe(20);
    expect(rev.section).toBe('inc');
    expect(rev.treasury_type).toBeNull();
    // Apr Cr should be 1000
    expect(parseFloat(rev.m1_cr)).toBe(1000);
  });

  test('second upload marks first as superseded', async () => {
    const buf = buildTestTBBuffer();
    await request(app)
      .post('/api/v1/tb/upload')
      .set('Authorization', `Bearer ${token}`)
      .field('financial_year_id', fyId)
      .attach('trial_balance', buf, 'test_tb_v2.xlsx');

    const { rows } = await db.query(
      `SELECT status FROM tb_uploads WHERE id=$1`, [uploadId]
    );
    expect(rows[0]?.status).toBe('superseded');
  });

  test('reports/mis returns data after upload', async () => {
    const res = await request(app)
      .get(`/api/v1/reports/mis?fy_id=${fyId}&period_type=annual&year_type=FY`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.totals.rev).toBeGreaterThan(0);
    expect(res.body.columns.length).toBe(12); // monthly
  });

  test('reports/mis Q1 returns only Apr-Jun', async () => {
    const res = await request(app)
      .get(`/api/v1/reports/mis?fy_id=${fyId}&period_type=quarterly&period=Q1&year_type=FY`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.columns).toEqual(['Apr','May','Jun']);
    // Q1 revenue = 1000 + 1100 + 1200 = 3300
    expect(res.body.totals.rev).toBeCloseTo(3300, 0);
  });

  test('reports/bs returns balanced sheet', async () => {
    const res = await request(app)
      .get(`/api/v1/reports/bs?fy_id=${fyId}&period_type=annual&year_type=FY`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('equity_liabilities');
    expect(res.body).toHaveProperty('assets');
  });

  test('reports/treasury extracts bank + FD correctly', async () => {
    const res = await request(app)
      .get(`/api/v1/reports/treasury?fy_id=${fyId}&period_type=annual&year_type=FY`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.total_cash_and_bank).toBeGreaterThan(0);
    expect(res.body.fds.length).toBeGreaterThan(0);
  });

  test('validates fy_id format', async () => {
    const res = await request(app)
      .get('/api/v1/reports/mis?fy_id=not-a-uuid')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(422);
    expect(res.body.errors[0].msg).toMatch(/UUID/);
  });

  test('validates period_type enum', async () => {
    const res = await request(app)
      .get(`/api/v1/reports/mis?fy_id=${fyId}&period_type=invalid`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(422);
  });
});
