const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

async function setupDatabase() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

module.exports = { setupDatabase };
