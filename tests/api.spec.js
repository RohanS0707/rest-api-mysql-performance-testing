const { test: base, expect } = require('@playwright/test');
const { pool } = require('../src/db');
require('dotenv').config();

const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN || 'local-admin-token-change-me';
const READ_TOKEN = process.env.READONLY_API_TOKEN || 'local-read-token-change-me';
const adminHeaders = { Authorization: `Bearer ${ADMIN_TOKEN}` };
const readHeaders = { Authorization: `Bearer ${READ_TOKEN}` };

const test = base.extend({
  productFactory: async ({ request }, use) => {
    const ids = [];
    const create = async (overrides = {}) => {
      const unique = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`.toUpperCase();
      const product = {
        sku: `PW-${unique}`,
        name: `Playwright Product ${unique}`,
        description: 'Created by an automated API test',
        price: 29.99,
        stock: 7,
        ...overrides,
      };
      const response = await request.post('/api/products', { headers: adminHeaders, data: product });
      expect(response.status()).toBe(201);
      const body = await response.json();
      ids.push(body.data.id);
      return body.data;
    };

    await use(create);
    await Promise.all(ids.map((id) => request.delete(`/api/products/${id}`, { headers: adminHeaders })));
  },
});

test.afterAll(async () => { await pool.end(); });

test('health endpoint confirms API and database are ready', async ({ request }) => {
  const response = await request.get('/health');
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok', database: 'connected' });
});

test('requires authentication and enforces read-only permissions', async ({ request, productFactory }) => {
  const anonymous = await request.get('/api/products');
  expect(anonymous.status()).toBe(401);
  expect((await anonymous.json()).error.code).toBe('UNAUTHORIZED');
  const invalidToken = await request.get('/api/products', { headers: { Authorization: 'Bearer definitely-wrong-token' } });
  expect(invalidToken.status()).toBe(401);

  const readOnlyWrite = await request.post('/api/products', {
    headers: readHeaders,
    data: { sku: 'READ-ONLY-1', name: 'Not Allowed', description: '', price: 1, stock: 1 },
  });
  expect(readOnlyWrite.status()).toBe(403);
  expect((await readOnlyWrite.json()).error.code).toBe('FORBIDDEN');
});

test('validates required fields, types, and boundary values', async ({ request, productFactory }) => {
  const invalid = await request.post('/api/products', {
    headers: adminHeaders,
    data: { sku: 'lowercase', name: 'x', price: -1, stock: 1.5 },
  });
  expect(invalid.status()).toBe(400);
  expect((await invalid.json()).error.code).toBe('VALIDATION_ERROR');

  const boundary = await productFactory({ sku: `EDGE-${Date.now()}`, name: 'Boundary item', price: 0, stock: 0 });
  expect(boundary.price).toBe(0);
  expect(boundary.stock).toBe(0);
});

test('creates, reads, updates, and deletes a product with SQL state validation', async ({ request, productFactory }) => {
  const created = await productFactory();
  expect(created.id).toBeGreaterThan(0);
  expect(created.price).toBe(29.99);

  const [afterCreate] = await pool.execute('SELECT sku, name, price, stock FROM products WHERE id = ?', [created.id]);
  expect(afterCreate).toHaveLength(1);
  expect(afterCreate[0]).toMatchObject({ sku: created.sku, name: created.name, price: 29.99, stock: 7 });

  const fetched = await request.get(`/api/products/${created.id}`, { headers: readHeaders });
  expect(fetched.status()).toBe(200);
  expect((await fetched.json()).data).toMatchObject({ id: created.id, sku: created.sku });

  const updatedPayload = { sku: created.sku, name: 'Updated test product', description: 'Updated through PUT', price: 41.5, stock: 12 };
  const updated = await request.put(`/api/products/${created.id}`, { headers: adminHeaders, data: updatedPayload });
  expect(updated.status()).toBe(200);
  expect((await updated.json()).data).toMatchObject({ name: updatedPayload.name, price: 41.5, stock: 12 });
  const [afterUpdate] = await pool.execute('SELECT name, price, stock FROM products WHERE id = ?', [created.id]);
  expect(afterUpdate[0]).toMatchObject({ name: updatedPayload.name, price: 41.5, stock: 12 });

  const deleted = await request.delete(`/api/products/${created.id}`, { headers: adminHeaders });
  expect(deleted.status()).toBe(204);
  const [afterDelete] = await pool.execute('SELECT id FROM products WHERE id = ?', [created.id]);
  expect(afterDelete).toHaveLength(0);
  const missing = await request.get(`/api/products/${created.id}`, { headers: readHeaders });
  expect(missing.status()).toBe(404);
});

test('rejects duplicate SKU and leaves exactly one database record', async ({ request, productFactory }) => {
  const original = await productFactory();
  const duplicate = await request.post('/api/products', {
    headers: adminHeaders,
    data: { sku: original.sku, name: 'Duplicate SKU', description: '', price: 2, stock: 1 },
  });
  expect(duplicate.status()).toBe(409);
  expect((await duplicate.json()).error.code).toBe('CONFLICT');
  const [rows] = await pool.execute('SELECT id FROM products WHERE sku = ?', [original.sku]);
  expect(rows).toHaveLength(1);
});

test('paginates and searches products without treating input as SQL', async ({ request, productFactory }) => {
  const product = await productFactory({ name: `Searchable-${Date.now()}` });
  const list = await request.get('/api/products?limit=1&offset=0', { headers: readHeaders });
  expect(list.status()).toBe(200);
  const page = await list.json();
  expect(page.data).toHaveLength(1);
  expect(page.pagination).toEqual({ limit: 1, offset: 0 });

  const search = await request.get(`/api/products?search=${encodeURIComponent(product.sku)}`, { headers: readHeaders });
  expect(search.status()).toBe(200);
  expect((await search.json()).data.some((item) => item.sku === product.sku)).toBe(true);

  const injectionLike = await request.get(`/api/products?search=${encodeURIComponent("' OR 1=1 --")}`, { headers: readHeaders });
  expect(injectionLike.status()).toBe(200);
  expect((await injectionLike.json()).data).toHaveLength(0);
});

test('rejects malformed IDs and invalid pagination parameters', async ({ request }) => {
  const badId = await request.get('/api/products/not-a-number', { headers: readHeaders });
  expect(badId.status()).toBe(400);
  const badLimit = await request.get('/api/products?limit=500', { headers: readHeaders });
  expect(badLimit.status()).toBe(400);
  const badOffset = await request.get('/api/products?offset=-1', { headers: readHeaders });
  expect(badOffset.status()).toBe(400);
});

test('does not expose protected write operations to a read-only token', async ({ request, productFactory }) => {
  const product = await productFactory();
  const update = await request.put(`/api/products/${product.id}`, {
    headers: readHeaders,
    data: { sku: product.sku, name: 'Unauthorized update', description: '', price: 1, stock: 0 },
  });
  expect(update.status()).toBe(403);
  const remove = await request.delete(`/api/products/${product.id}`, { headers: readHeaders });
  expect(remove.status()).toBe(403);
});

module.exports = { adminHeaders, readHeaders };

