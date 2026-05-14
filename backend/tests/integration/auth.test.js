'use strict';
/**
 * Integration tests — /api/v1/auth/*
 * Requires a running PostgreSQL test database.
 * Skip gracefully if DB unavailable.
 */

const request = require('supertest');
const bcrypt  = require('bcryptjs');

let app, db, companyId, userId;

// Skip all tests if no DB
const DB_AVAILABLE = Boolean(process.env.DB_PASSWORD);
const describeIf   = DB_AVAILABLE ? describe : describe.skip;

beforeAll(async () => {
  if (!DB_AVAILABLE) return;
  process.env.NODE_ENV = 'test';
  process.env.DB_NAME  = 'fincommand_test';
  app = require('../../server');
  db  = require('../../db/connection');

  // Seed test company + user
  const { rows: [co] } = await db.query(
    `INSERT INTO companies (name, cin, fiscal_year_start)
     VALUES ('Test Co Ltd', 'TEST001', 4) RETURNING id`
  );
  companyId = co.id;

  const hash = await bcrypt.hash('Test@12345', 4);
  const { rows: [u] } = await db.query(
    `INSERT INTO users (company_id, name, email, password_hash, role, email_verified)
     VALUES ($1,'Test CFO','cfo@testco.in',$2,'cfo',TRUE) RETURNING id`,
    [companyId, hash]
  );
  userId = u.id;
});

afterAll(async () => {
  if (!DB_AVAILABLE) return;
  await db.query('DELETE FROM companies WHERE id=$1', [companyId]);
  await db.pool.end();
});

describeIf('POST /api/v1/auth/login', () => {
  test('returns tokens on valid credentials', async () => {
    const res = await request(app).post('/api/v1/auth/login')
      .send({ email:'cfo@testco.in', password:'Test@12345' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('access_token');
    expect(res.body).toHaveProperty('refresh_token');
    expect(res.body.user.role).toBe('cfo');
  });

  test('returns 401 on wrong password', async () => {
    const res = await request(app).post('/api/v1/auth/login')
      .send({ email:'cfo@testco.in', password:'WrongPass' });
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
  });

  test('returns 422 on invalid email format', async () => {
    const res = await request(app).post('/api/v1/auth/login')
      .send({ email:'notanemail', password:'Test@12345' });
    expect(res.status).toBe(422);
  });

  test('returns 401 on unknown email', async () => {
    const res = await request(app).post('/api/v1/auth/login')
      .send({ email:'nobody@nowhere.com', password:'Test@12345' });
    expect(res.status).toBe(401);
  });
});

describeIf('GET /api/v1/auth/me', () => {
  let token;
  beforeAll(async () => {
    const res = await request(app).post('/api/v1/auth/login')
      .send({ email:'cfo@testco.in', password:'Test@12345' });
    token = res.body.access_token;
  });

  test('returns user profile with valid token', async () => {
    const res = await request(app).get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('cfo@testco.in');
    expect(res.body).not.toHaveProperty('password_hash');
  });

  test('returns 401 without token', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  test('returns 401 with malformed token', async () => {
    const res = await request(app).get('/api/v1/auth/me')
      .set('Authorization', 'Bearer bad.token.here');
    expect(res.status).toBe(401);
  });
});

describeIf('POST /api/v1/auth/refresh', () => {
  let refreshToken;
  beforeAll(async () => {
    const res = await request(app).post('/api/v1/auth/login')
      .send({ email:'cfo@testco.in', password:'Test@12345' });
    refreshToken = res.body.refresh_token;
  });

  test('returns new access token with valid refresh token', async () => {
    const res = await request(app).post('/api/v1/auth/refresh')
      .send({ refresh_token: refreshToken });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('access_token');
  });

  test('returns 401 with invalid refresh token', async () => {
    const res = await request(app).post('/api/v1/auth/refresh')
      .send({ refresh_token: 'invalid.refresh.token' });
    expect(res.status).toBe(401);
  });
});

describeIf('POST /api/v1/auth/logout', () => {
  test('returns 200 and revokes token', async () => {
    const loginRes = await request(app).post('/api/v1/auth/login')
      .send({ email:'cfo@testco.in', password:'Test@12345' });
    const { access_token, refresh_token } = loginRes.body;

    const logoutRes = await request(app).post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${access_token}`)
      .send({ refresh_token });
    expect(logoutRes.status).toBe(200);

    // Refresh token should now be revoked
    const refreshRes = await request(app).post('/api/v1/auth/refresh')
      .send({ refresh_token });
    expect(refreshRes.status).toBe(401);
  });
});
