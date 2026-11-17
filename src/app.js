const express = require('express');
const { timingSafeEqual } = require('node:crypto');
const helmet = require('helmet');
const { pool } = require('./db');

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '32kb', strict: true }));

const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN || 'local-admin-token-change-me';
const READ_TOKEN = process.env.READONLY_API_TOKEN || 'local-read-token-change-me';
const SKU_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,39}$/;

function tokenMatches(candidate, expected) {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sendError(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

function authenticate(requiredRole = 'read') {
  return (req, res, next) => {
    const value = req.get('authorization') || '';
    const match = /^Bearer\s+(.+)$/i.exec(value);
    if (!match) return sendError(res, 401, 'UNAUTHORIZED', 'A bearer token is required.');
    const token = match[1];
    if (tokenMatches(token, ADMIN_TOKEN)) {
      req.role = 'admin';
      return next();
    }
    if (tokenMatches(token, READ_TOKEN)) {
      req.role = 'read';
      if (requiredRole === 'admin') return sendError(res, 403, 'FORBIDDEN', 'Admin role is required.');
      return next();
    }
    return sendError(res, 401, 'UNAUTHORIZED', 'The bearer token is invalid.');
  };
}

function validateId(req, res, next) {
  if (!/^[1-9]\d*$/.test(req.params.id)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Product id must be a positive integer.');
  }
  req.productId = Number(req.params.id);
  if (!Number.isSafeInteger(req.productId)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Product id is outside the supported range.');
  }
  next();
}

function validateProduct(body, res) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendError(res, 400, 'VALIDATION_ERROR', 'Request body must be a JSON object.');
    return null;
  }
  const { sku, name, description = '', price, stock } = body;
  const problems = [];
  if (typeof sku !== 'string' || !SKU_PATTERN.test(sku)) problems.push('sku must be 2–40 uppercase letters, digits, or hyphens.');
  if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 120) problems.push('name must be 2–120 characters.');
  if (typeof description !== 'string' || description.length > 1000) problems.push('description must be a string of at most 1000 characters.');
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0 || price > 99999999.99 || Math.round(price * 100) !== price * 100) problems.push('price must be a number from 0 to 99999999.99 with at most two decimal places.');
  if (!Number.isInteger(stock) || stock < 0 || stock > 2147483647) problems.push('stock must be a non-negative 32-bit integer.');
  if (problems.length) {
    sendError(res, 400, 'VALIDATION_ERROR', 'Product data is invalid.', problems);
    return null;
  }
  return { sku, name: name.trim(), description, price, stock };
}

function toProduct(row) {
  return { ...row, price: Number(row.price), stock: Number(row.stock) };
}

app.get('/health', async (_req, res, next) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (error) { next(error); }
});

app.get('/api/products', authenticate('read'), async (req, res, next) => {
  try {
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    const search = req.query.search === undefined ? '' : String(req.query.search);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || search.length > 120) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'limit must be 1–100, offset must be non-negative, and search at most 120 characters.');
    }
    const pattern = `%${search}%`;
    const [rows] = await pool.execute(
      'SELECT id, sku, name, description, price, stock, created_at, updated_at FROM products WHERE (? = \'%%\' OR name LIKE ? OR sku LIKE ?) ORDER BY id DESC LIMIT ? OFFSET ?',
      [pattern, pattern, pattern, limit, offset]
    );
    res.json({ data: rows.map(toProduct), pagination: { limit, offset } });
  } catch (error) { next(error); }
});

app.get('/api/products/:id', authenticate('read'), validateId, async (req, res, next) => {
  try {
    const [rows] = await pool.execute('SELECT id, sku, name, description, price, stock, created_at, updated_at FROM products WHERE id = ?', [req.productId]);
    if (!rows.length) return sendError(res, 404, 'NOT_FOUND', 'Product was not found.');
    res.json({ data: toProduct(rows[0]) });
  } catch (error) { next(error); }
});

app.post('/api/products', authenticate('admin'), async (req, res, next) => {
  const product = validateProduct(req.body, res);
  if (!product) return;
  try {
    const [result] = await pool.execute(
      'INSERT INTO products (sku, name, description, price, stock) VALUES (?, ?, ?, ?, ?)',
      [product.sku, product.name, product.description, product.price, product.stock]
    );
    const [rows] = await pool.execute('SELECT id, sku, name, description, price, stock, created_at, updated_at FROM products WHERE id = ?', [result.insertId]);
    res.status(201).location(`/api/products/${result.insertId}`).json({ data: toProduct(rows[0]) });
  } catch (error) { next(error); }
});

app.put('/api/products/:id', authenticate('admin'), validateId, async (req, res, next) => {
  const product = validateProduct(req.body, res);
  if (!product) return;
  try {
    const [result] = await pool.execute(
      'UPDATE products SET sku = ?, name = ?, description = ?, price = ?, stock = ? WHERE id = ?',
      [product.sku, product.name, product.description, product.price, product.stock, req.productId]
    );
    if (!result.affectedRows) return sendError(res, 404, 'NOT_FOUND', 'Product was not found.');
    const [rows] = await pool.execute('SELECT id, sku, name, description, price, stock, created_at, updated_at FROM products WHERE id = ?', [req.productId]);
    res.json({ data: toProduct(rows[0]) });
  } catch (error) { next(error); }
});

app.delete('/api/products/:id', authenticate('admin'), validateId, async (req, res, next) => {
  try {
    const [result] = await pool.execute('DELETE FROM products WHERE id = ?', [req.productId]);
    if (!result.affectedRows) return sendError(res, 404, 'NOT_FOUND', 'Product was not found.');
    res.status(204).end();
  } catch (error) { next(error); }
});

app.use((_req, res) => sendError(res, 404, 'NOT_FOUND', 'Route was not found.'));
app.use((error, _req, res, _next) => {
  if (error.type === 'entity.parse.failed') return sendError(res, 400, 'VALIDATION_ERROR', 'Request body contains invalid JSON.');
  if (error.code === 'ER_DUP_ENTRY') return sendError(res, 409, 'CONFLICT', 'A product with this SKU already exists.');
  console.error('Unhandled API error:', error.message);
  return sendError(res, 500, 'INTERNAL_ERROR', 'An unexpected server error occurred.');
});

module.exports = { app };

