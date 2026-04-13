import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestAppContext } from '../fixtures/app.js';
import { flushCache, resetDatabase } from '../fixtures/db.js';

describe('resources CRUD', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await resetDatabase(ctx.deps.db);
    await flushCache(ctx.deps.redis);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('POST /resources creates a resource and returns 201 with Location header', async () => {
    const res = await ctx.request
      .post('/api/v1/resources')
      .send({ name: 'widget-a', type: 'widget', tags: ['demo'] });

    expect(res.status).toBe(201);
    expect(res.headers['location']).toBe(`/api/v1/resources/${res.body.id as string}`);
    expect(res.body).toMatchObject({
      name: 'widget-a',
      type: 'widget',
      status: 'active',
      tags: ['demo'],
      metadata: {},
      ownerId: null,
    });
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.createdAt).toBe(res.body.updatedAt);
  });

  it('GET /resources/:id returns the resource after create', async () => {
    const created = await ctx.request
      .post('/api/v1/resources')
      .send({ name: 'widget-b', type: 'widget' });

    const fetched = await ctx.request.get(`/api/v1/resources/${created.body.id as string}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.id).toBe(created.body.id);
    expect(fetched.body.name).toBe('widget-b');
  });

  it('PATCH /resources/:id partially updates a single field and bumps updatedAt', async () => {
    const created = await ctx.request
      .post('/api/v1/resources')
      .send({ name: 'widget-c', type: 'widget' });
    const originalUpdatedAt = created.body.updatedAt as string;

    // Ensure wall-clock advances enough for ISO strings to differ.
    await new Promise((r) => setTimeout(r, 10));

    const patched = await ctx.request
      .patch(`/api/v1/resources/${created.body.id as string}`)
      .send({ status: 'archived' });

    expect(patched.status).toBe(200);
    expect(patched.body.status).toBe('archived');
    expect(patched.body.name).toBe('widget-c');
    expect(patched.body.type).toBe('widget');
    expect(new Date(patched.body.updatedAt as string).getTime()).toBeGreaterThan(
      new Date(originalUpdatedAt).getTime(),
    );
  });

  it('PATCH replaces metadata wholesale (policy: replace, not merge)', async () => {
    const created = await ctx.request
      .post('/api/v1/resources')
      .send({ name: 'widget-d', type: 'widget', metadata: { a: 1, b: 2 } });

    const patched = await ctx.request
      .patch(`/api/v1/resources/${created.body.id as string}`)
      .send({ metadata: { c: 3 } });

    expect(patched.body.metadata).toEqual({ c: 3 });
  });

  it('DELETE /resources/:id returns 204 with empty body', async () => {
    const created = await ctx.request
      .post('/api/v1/resources')
      .send({ name: 'widget-e', type: 'widget' });

    const deleted = await ctx.request.delete(`/api/v1/resources/${created.body.id as string}`);
    expect(deleted.status).toBe(204);
    expect(deleted.body).toEqual({});
  });

  it('GET /resources/:id after DELETE returns 404', async () => {
    const created = await ctx.request
      .post('/api/v1/resources')
      .send({ name: 'widget-f', type: 'widget' });

    await ctx.request.delete(`/api/v1/resources/${created.body.id as string}`);
    const fetched = await ctx.request.get(`/api/v1/resources/${created.body.id as string}`);
    expect(fetched.status).toBe(404);
    expect(fetched.body.error.code).toBe('NOT_FOUND');
  });
});
