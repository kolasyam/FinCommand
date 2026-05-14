'use strict';
const db = require('../db/connection');

const audit = (action, entityType = null) => async (req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = function (body) {
    if (res.statusCode < 400 && req.user) {
      db.query(
        `INSERT INTO audit_trail
          (company_id, user_id, user_name, user_role, action,
           entity_type, entity_id, metadata, ip_address, user_agent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          req.user.company_id, req.user.id, req.user.name, req.user.role,
          action, entityType,
          body?.id || req.params?.id || null,
          JSON.stringify({ method: req.method, path: req.path, query: req.query }),
          req.ip, req.headers['user-agent'] || null,
        ]
      ).catch(() => {}); // non-blocking
    }
    return originalJson(body);
  };
  next();
};

module.exports = { audit };
