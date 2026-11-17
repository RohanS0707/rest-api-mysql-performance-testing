const mysql = require('mysql2/promise');
const fs = require('node:fs');
const path = require('node:path');

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'shop_test',
  password: process.env.DB_PASSWORD || 'local-db-password-change-me',
  database: process.env.DB_NAME || 'shop_api_test',
  waitForConnections: true,
  connectionLimit: 10,
  decimalNumbers: true,
});

async function initializeDatabase() {
  const schemaPath = path.join(__dirname, 'sql', 'schema.sql');
  await pool.query(fs.readFileSync(schemaPath, 'utf8'));
}

module.exports = { pool, initializeDatabase };
