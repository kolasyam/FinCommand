// uuid 14 ships ES modules only, which Jest's CommonJS runtime cannot load; exceljs only needs v4.
const { randomUUID } = require('crypto');
module.exports = { v4: () => randomUUID() };
