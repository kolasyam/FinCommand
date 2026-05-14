'use strict';
const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { body, validationResult } = require('express-validator');
const db      = require('../db/connection');
const { authenticate } = require('../middleware/auth');

const signAccess  = (sub, role, companyId) =>
  jwt.sign({ sub, role, company_id: companyId }, process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '15m' });

const signRefresh = (sub) =>
  jwt.sign({ sub }, process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' });

// ── POST /auth/login ──
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const { email, password } = req.body;
    const { rows } = await db.query(
      `SELECT u.*, c.name AS company_name
       FROM users u JOIN companies c ON c.id = u.company_id
       WHERE u.email=$1`, [email]
    );
    const user = rows[0];

    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (!user.is_active) return res.status(403).json({ error: 'Account inactive' });
    if (user.locked_until && new Date(user.locked_until) > new Date())
      return res.status(429).json({ error: 'Account locked. Try again later.' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      await db.query(
        `UPDATE users SET failed_attempts = failed_attempts + 1,
          locked_until = CASE WHEN failed_attempts >= 4 THEN NOW() + INTERVAL '15 minutes' ELSE locked_until END
         WHERE id=$1`, [user.id]
      );
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Reset failed attempts, update last_login
    await db.query(
      `UPDATE users SET failed_attempts=0, locked_until=NULL, last_login=NOW() WHERE id=$1`,
      [user.id]
    );

    const accessToken  = signAccess(user.id, user.role, user.company_id);
    const refreshToken = signRefresh(user.id);
    const expiresAt    = new Date(Date.now() + 7 * 24 * 3600 * 1000);

    await db.query(
      `INSERT INTO refresh_tokens (user_id, token, ip_address, user_agent, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [user.id, refreshToken, req.ip, req.headers['user-agent'], expiresAt]
    );

    // Audit
    await db.query(
      `INSERT INTO audit_trail (company_id,user_id,user_name,user_role,action,ip_address,user_agent)
       VALUES ($1,$2,$3,$4,'LOGIN',$5,$6)`,
      [user.company_id, user.id, user.name, user.role, req.ip, req.headers['user-agent']]
    );

    res.json({
      access_token:  accessToken,
      refresh_token: refreshToken,
      token_type:    'Bearer',
      expires_in:    900, // seconds
      user: {
        id:           user.id,
        name:         user.name,
        email:        user.email,
        role:         user.role,
        company_id:   user.company_id,
        company_name: user.company_name,
      },
    });
  } catch (err) { next(err); }
});

// ── POST /auth/refresh ──
router.post('/refresh', async (req, res, next) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'refresh_token required' });

    let payload;
    try {
      payload = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const { rows } = await db.query(
      `SELECT rt.*, u.role, u.company_id, u.is_active
       FROM refresh_tokens rt JOIN users u ON u.id=rt.user_id
       WHERE rt.token=$1 AND rt.revoked_at IS NULL AND rt.expires_at > NOW()`,
      [refresh_token]
    );
    if (!rows.length) return res.status(401).json({ error: 'Token revoked or expired' });
    if (!rows[0].is_active) return res.status(403).json({ error: 'Account inactive' });

    const newAccess = signAccess(rows[0].user_id, rows[0].role, rows[0].company_id);
    res.json({ access_token: newAccess, token_type: 'Bearer', expires_in: 900 });
  } catch (err) { next(err); }
});

// ── POST /auth/logout ──
router.post('/logout', authenticate, async (req, res, next) => {
  try {
    const { refresh_token } = req.body;
    if (refresh_token) {
      await db.query(
        `UPDATE refresh_tokens SET revoked_at=NOW() WHERE token=$1 AND user_id=$2`,
        [refresh_token, req.user.id]
      );
    }
    await db.query(
      `INSERT INTO audit_trail (company_id,user_id,user_name,user_role,action,ip_address)
       VALUES ($1,$2,$3,$4,'LOGOUT',$5)`,
      [req.user.company_id, req.user.id, req.user.name, req.user.role, req.ip]
    );
    res.json({ message: 'Logged out successfully' });
  } catch (err) { next(err); }
});

// ── GET /auth/me ──
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.name, u.email, u.role, u.permissions, u.last_login,
              u.created_at, c.id AS company_id, c.name AS company_name,
              c.cin, c.fiscal_year_start
       FROM users u JOIN companies c ON c.id=u.company_id
       WHERE u.id=$1`, [req.user.id]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── POST /auth/change-password ──
router.post('/change-password', authenticate, [
  body('current_password').notEmpty(),
  body('new_password').isLength({ min: 8 }).matches(/[A-Z]/).matches(/[0-9]/),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const { current_password, new_password } = req.body;
    const { rows } = await db.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    const match = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!match) return res.status(400).json({ error: 'Current password incorrect' });

    const hash = await bcrypt.hash(new_password, parseInt(process.env.BCRYPT_ROUNDS || '12'));
    await db.query('UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2', [hash, req.user.id]);
    // Revoke all refresh tokens
    await db.query('UPDATE refresh_tokens SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL', [req.user.id]);

    res.json({ message: 'Password changed successfully. Please login again.' });
  } catch (err) { next(err); }
});

module.exports = router;
