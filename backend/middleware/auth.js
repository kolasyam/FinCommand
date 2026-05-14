'use strict';
const jwt    = require('jsonwebtoken');
const db     = require('../db/connection');

// ── Verify JWT and attach user to req ──
const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer '))
      return res.status(401).json({ error: 'No token provided' });

    const token = header.slice(7);
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
      return res.status(401).json({ error: e.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token' });
    }

    const { rows } = await db.query(
      `SELECT u.id, u.name, u.email, u.role, u.company_id,
              u.is_active, u.permissions, c.name AS company_name
       FROM users u JOIN companies c ON c.id = u.company_id
       WHERE u.id = $1`, [payload.sub]
    );
    if (!rows.length || !rows[0].is_active)
      return res.status(401).json({ error: 'User not found or inactive' });

    req.user = rows[0];
    next();
  } catch (err) {
    next(err);
  }
};

// ── Role guard factory ──
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
  if (!roles.includes(req.user.role))
    return res.status(403).json({
      error: `Access denied. Required role: ${roles.join(' or ')}`,
      your_role: req.user.role,
    });
  next();
};

// Pre-built role guards
const isAdmin       = requireRole('admin');
const isCFO         = requireRole('admin', 'cfo');
const isCFOorCEO    = requireRole('admin', 'cfo', 'ceo');
const canWrite      = requireRole('admin', 'cfo', 'manager');
const canRead       = requireRole('admin', 'cfo', 'ceo', 'auditor', 'manager', 'viewer');

module.exports = { authenticate, requireRole, isAdmin, isCFO, isCFOorCEO, canWrite, canRead };
