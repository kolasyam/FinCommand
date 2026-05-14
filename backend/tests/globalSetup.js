'use strict';
// tests/globalSetup.js
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

module.exports = async () => {
  process.env.NODE_ENV = 'test';
  process.env.DB_NAME  = process.env.TEST_DB_NAME || 'fincommand_test';
  process.env.DB_HOST  = process.env.DB_HOST  || 'localhost';
  process.env.DB_USER  = process.env.DB_USER  || 'fincommand_user';
  process.env.DB_PORT  = process.env.DB_PORT  || '5432';
  process.env.JWT_SECRET         = 'test_jwt_secret_32_chars_minimum_ok';
  process.env.JWT_REFRESH_SECRET = 'test_refresh_secret_32_chars_min_ok';
  process.env.JWT_EXPIRES_IN     = '15m';
  process.env.BCRYPT_ROUNDS      = '4'; // fast for tests
  process.env.UPLOAD_DIR         = '/tmp/fc_test_uploads';
  process.env.LOG_LEVEL          = 'silent';

  const adminPool = new Pool({
    host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT),
    database: 'postgres',
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });

  try {
    await adminPool.query(`DROP DATABASE IF EXISTS fincommand_test`);
    await adminPool.query(`CREATE DATABASE fincommand_test`);
    const testPool = new Pool({
      host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT),
      database: 'fincommand_test',
      user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    });
    const schema = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
    await testPool.query(schema);
    await testPool.end();
    console.log('✅ Test database created');
  } catch (e) {
    console.warn('⚠ Could not create test DB (no PG available):', e.message);
    console.warn('   Unit tests will still run; integration tests will be skipped.');
  } finally {
    await adminPool.end().catch(() => {});
  }
};
