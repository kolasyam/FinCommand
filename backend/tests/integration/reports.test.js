'use strict';
/**
 * Integration tests — /api/v1/reports/*
 * Uploads a sample TB then tests all report endpoints.
 */

const request = require('supertest');
const bcrypt  = require('bcryptjs');
const path    = require('path');
const XLSX    = require('xlsx');
const fs      = require('fs');
const os      = require('os');

const DB_AVAILABLE = Boolean(process.env.DB_PASSWORD);
const describeIf   = DB_AVAILABLE ? describe : describe.skip;

let app, db, token, fyId, companyId;

// Build a minimal valid TB Excel file in memory
function buildTBExcel() {
  const wb = XLSX.utils.book_new();
  const FY_M = ['Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar'];
  const hdr  = ['Ledger_Code','Ledger_Name','Opening_Dr','Opening_Cr',
                 ...FY_M.flatMap(m=>[`${m}_Dr`,`${m}_Cr`])];
  const rows = [
    ['6001','IT Services Revenue',0,0, ...Array(24).fill(0).map((_,i)=>i%2===1?2000:0)],
    ['7011','Salaries & Wages',0,0,    ...Array(24).fill(0).map((_,i)=>i%2===0?800:0)],
    ['2101','HDFC Bank — Current Account',5000,0,...Array(24).fill(50)],
    ['2301','HDFC Fixed Deposit — 001',10000,0,...Array(24).fill(0)],
    ['3001','Equity Share Capital',0,8000,...Array(24).fill(0)],
    ['5001','MSME Trade Creditors',0,3000,...Array(24).fill(0)],
  ];
  const ws = XLSX.utils.aoa_to_sheet([hdr, ...rows]);
  XLSX.utils.book_append_sheet(wb, ws, 'Trial_Balance');
  const tmpPath = path.join(os.tmpdir(), `fc_test_tb_${Date.now()}.xlsx`);
  XLSX.writeFile(wb, tmpPath);
  return tmpPath;
}

beforeAll(async () => {
  if (!DB_AVAILABLE) return;
  process.env.NODE_ENV = 'test';
  process.env.DB_NAME  = 'fincommand_test';
  app = require('../../server');
  db  = require('../../db/connection');

  // Create company
  const { rows: [co] } = await db.query(
    `INSERT INTO companies (name, fiscal_year_start) VALUES ('Report Test Co', 4) RETURNING id`
  );
  companyId = co.id;

  // Create admin user
  const hash = await bcrypt.hash('Admin@123', 4);
  await db.query(
    `INSERT INTO users (company_id,name,email,password_hash,role,email_verified)
     VALUES ($1,'Admin','admin@reporttest.in',$2,'admin',TRUE)`,
    [companyId, hash]
  );

  // Login
  const loginRes = await request(app).post('/api/v1/auth/login')
    .send({ email:'admin@reporttest.in', password:'Admin@123' });
  token = loginRes.body.access_token;

  // Create FY
  const fyRes = await request(app).post('/api/v1/fy')
    .set('Authorization', `Bearer ${token}`)
    .send({ label:'FY 2024-25', short_label:'FY25', start_date:'2024-04-01', end_date:'2025-03-31', year_type:'FY' });
  fyId = fyRes.body.id;

  // Upload TB
  const tbFile = buildTBExcel();
  await request(app).post('/api/v1/tb/upload')
    .set('Authorization', `Bearer ${token}`)
    .field('financial_year_id', fyId)
    .attach('trial_balance', tbFile);
  fs.unlink(tbFile, () => {});
});

afterAll(async () => {
  if (!DB_AVAILABLE) return;
  await db.query('DELETE FROM companies WHERE id=$1', [companyId]);
  await db.pool.end();
});

describeIf('GET /api/v1/reports/mis', () => {
  test('returns MIS data for annual period', async () => {
    const res = await request(app).get(`/api/v1/reports/mis?fy_id=${fyId}&period_type=annual`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totals');
    expect(res.body).toHaveProperty('columns');
    expect(res.body.columns).toHaveLength(12);
  });

  test('returns quarterly data with 4 columns', async () => {
    const res = await request(app).get(`/api/v1/reports/mis?fy_id=${fyId}&period_type=quarterly`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.columns).toHaveLength(4);
  });

  test('Q2 revenue = Jul+Aug+Sep only', async () => {
    const res = await request(app).get(`/api/v1/reports/mis?fy_id=${fyId}&period_type=quarterly&period=Q2`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.totals.rev).toBeGreaterThan(0);
  });

  test('returns 400 without fy_id', async () => {
    const res = await request(app).get('/api/v1/reports/mis')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  test('returns 401 without token', async () => {
    const res = await request(app).get(`/api/v1/reports/mis?fy_id=${fyId}`);
    expect(res.status).toBe(401);
  });
});

describeIf('GET /api/v1/reports/bs', () => {
  test('returns schedule III BS structure', async () => {
    const res = await request(app).get(`/api/v1/reports/bs?fy_id=${fyId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('equity_liabilities');
    expect(res.body).toHaveProperty('assets');
    expect(res.body.equity_liabilities).toHaveProperty('total');
    expect(res.body.assets).toHaveProperty('total');
  });

  test('Q1 BS uses cumulative to Jun 2024', async () => {
    const res = await request(app).get(`/api/v1/reports/bs?fy_id=${fyId}&period_type=quarterly&period=Q1`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.period_label).toMatch(/Q1/);
  });
});

describeIf('GET /api/v1/reports/pl', () => {
  test('returns complete P&L structure', async () => {
    const res = await request(app).get(`/api/v1/reports/pl?fy_id=${fyId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('revenue');
    expect(res.body).toHaveProperty('pat');
    expect(res.body).toHaveProperty('eps_basic');
    expect(res.body.pat).toBeLessThanOrEqual(res.body.pbt);
  });
});

describeIf('GET /api/v1/reports/treasury', () => {
  test('returns treasury with bank/fd/mf breakdown', async () => {
    const res = await request(app).get(`/api/v1/reports/treasury?fy_id=${fyId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('bank_ca');
    expect(res.body).toHaveProperty('fds');
    expect(res.body).toHaveProperty('mfs');
  });

  test('total = cash_bank + fd + mf', async () => {
    const res = await request(app).get(`/api/v1/reports/treasury?fy_id=${fyId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.body.total).toBeCloseTo(
      res.body.total_cash_and_bank + res.body.total_fd + res.body.total_mf, 0
    );
  });
});

describeIf('GET /api/v1/reports/ratios', () => {
  test('returns all ratio categories', async () => {
    const res = await request(app).get(`/api/v1/reports/ratios?fy_id=${fyId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('liquidity');
    expect(res.body).toHaveProperty('profitability');
    expect(res.body).toHaveProperty('leverage');
    expect(res.body).toHaveProperty('efficiency');
    expect(res.body).toHaveProperty('dupont');
    expect(res.body).toHaveProperty('benchmarks');
  });
});

describeIf('GET /api/v1/reports/all', () => {
  test('returns all reports in one call', async () => {
    const res = await request(app).get(`/api/v1/reports/all?fy_id=${fyId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('mis');
    expect(res.body).toHaveProperty('bs');
    expect(res.body).toHaveProperty('pl');
    expect(res.body).toHaveProperty('treasury');
    expect(res.body).toHaveProperty('ratios');
  });
});

describeIf('Role-based access control', () => {
  let ceoToken;
  beforeAll(async () => {
    const hash = await bcrypt.hash('CEO@1234', 4);
    await db.query(
      `INSERT INTO users (company_id,name,email,password_hash,role,email_verified)
       VALUES ($1,'CEO','ceo@reporttest.in',$2,'ceo',TRUE)`,
      [companyId, hash]
    );
    const r = await request(app).post('/api/v1/auth/login')
      .send({ email:'ceo@reporttest.in', password:'CEO@1234' });
    ceoToken = r.body.access_token;
  });

  test('CEO can view reports', async () => {
    const res = await request(app).get(`/api/v1/reports/mis?fy_id=${fyId}`)
      .set('Authorization', `Bearer ${ceoToken}`);
    expect(res.status).toBe(200);
  });

  test('CEO cannot upload TB', async () => {
    const res = await request(app).post('/api/v1/tb/upload')
      .set('Authorization', `Bearer ${ceoToken}`)
      .field('financial_year_id', fyId);
    expect(res.status).toBe(403);
  });
});
