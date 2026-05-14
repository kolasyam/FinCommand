'use strict';
const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'fincommand',
  user:     process.env.DB_USER     || 'fincommand_user',
  password: process.env.DB_PASSWORD,
  min:      parseInt(process.env.DB_POOL_MIN || '2'),
  max:      parseInt(process.env.DB_POOL_MAX || '10'),
  idleTimeoutMillis:    30000,
  connectionTimeoutMillis: 5000,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err.message);
});

// Verify connection on startup
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
    return;
  }
  client.query('SELECT NOW()', (err2) => {
    release();
    if (err2) return console.error('❌ DB query failed:', err2.message);
    console.log('✅ PostgreSQL connected');
  });
});

module.exports = {
  pool,
  query:     (text, params) => pool.query(text, params),
  getClient: ()             => pool.connect(),
  // Transaction helper
  withTransaction: async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};
