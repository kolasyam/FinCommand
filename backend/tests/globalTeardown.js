'use strict';
const { Pool } = require('pg');

module.exports = async () => {
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: 'postgres',
    user: process.env.DB_USER || 'fincommand_user',
    password: process.env.DB_PASSWORD,
  });
  try {
    await pool.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = 'fincommand_test' AND pid <> pg_backend_pid()`);
    await pool.query(`DROP DATABASE IF EXISTS fincommand_test`);
    console.log('✅ Test database dropped');
  } catch (e) {
    console.warn('Could not drop test DB:', e.message);
  } finally {
    await pool.end().catch(() => {});
  }
};
