import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestAppContext } from '../fixtures/app.js';
import { flushCache, resetDatabase } from '../fixtures/db.js';

describe('resources cache behavior', () => {
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

  it('first GET /:id is MISS, second GET /:id is HIT', async () => {
    const created = await ctx.request.post('/api/v1/resources').send({ name: 'w', type: 'widget' });

    const first = await ctx.request.get(`/api/v1/resources/${created.body.id as string}`);
    expect(first.status).toBe(200);
    expect(first.headers['x-cache']).toBe('MISS');

    const second = await ctx.request.get(`/api/v1/resources/${created.body.id as string}`);
    expect(second.status).toBe(200);
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.body).toEqual(first.body);
  });

  it('PATCH invalidates the detail cache so the next GET is MISS', async () => {
    const created = await ctx.request.post('/api/v1/resources').send({ name: 'w', type: 'widget' });
    const id = created.body.id as string;

    await ctx.request.get(`/api/v1/resources/${id}`); // MISS → populate
    const hit = await ctx.request.get(`/api/v1/resources/${id}`); // HIT
    expect(hit.headers['x-cache']).toBe('HIT');

    await ctx.request.patch(`/api/v1/resources/${id}`).send({ status: 'archived' });

    const postPatch = await ctx.request.get(`/api/v1/resources/${id}`);
    expect(postPatch.headers['x-cache']).toBe('MISS');
    expect(postPatch.body.status).toBe('archived');
  });

  it('DELETE invalidates the detail cache', async () => {
    const created = await ctx.request.post('/api/v1/resources').send({ name: 'w', type: 'widget' });
    const id = created.body.id as string;

    await ctx.request.get(`/api/v1/resources/${id}`); // populate
    await ctx.request.delete(`/api/v1/resources/${id}`);

    const fetched = await ctx.request.get(`/api/v1/resources/${id}`);
    expect(fetched.status).toBe(404);
  });

  it('list cache: second identical list GET is HIT', async () => {
    await ctx.request.post('/api/v1/resources').send({ name: 'a', type: 'widget' });
    await ctx.request.post('/api/v1/resources').send({ name: 'b', type: 'widget' });

    const first = await ctx.request.get('/api/v1/resources?limit=5');
    expect(first.headers['x-cache']).toBe('MISS');

    const second = await ctx.request.get('/api/v1/resources?limit=5');
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.body.data.length).toBe(first.body.data.length);
  });

  it('creating a resource invalidates the list cache (version counter bumps)', async () => {
    await ctx.request.post('/api/v1/resources').send({ name: 'a', type: 'widget' });
    await ctx.request.get('/api/v1/resources?limit=5'); // warm
    const warm = await ctx.request.get('/api/v1/resources?limit=5');
    expect(warm.headers['x-cache']).toBe('HIT');

    await ctx.request.post('/api/v1/resources').send({ name: 'b', type: 'widget' });

    const afterWrite = await ctx.request.get('/api/v1/resources?limit=5');
    expect(afterWrite.headers['x-cache']).toBe('MISS');
    expect(afterWrite.body.data.length).toBe(2);
  });

  it('normalized filter equivalence: reordered query keys hit the same entry', async () => {
    await ctx.request
      .post('/api/v1/resources')
      .send({ name: 'a', type: 'widget', status: 'active' });

    const first = await ctx.request.get('/api/v1/resources?type=widget&status=active');
    expect(first.headers['x-cache']).toBe('MISS');

    const second = await ctx.request.get('/api/v1/resources?status=active&type=widget');
    expect(second.headers['x-cache']).toBe('HIT');
  });
});

describe('resources cache disabled (CACHE_ENABLED=false)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp({ CACHE_ENABLED: 'false' });
  });

  afterEach(async () => {
    await resetDatabase(ctx.deps.db);
    await flushCache(ctx.deps.redis);
  });

  afterAll(async () => {
    // Restore for downstream suites.
    process.env['CACHE_ENABLED'] = 'true';
    await ctx.close();
  });

  it('every GET /:id responds with X-Cache: BYPASS', async () => {
    const created = await ctx.request.post('/api/v1/resources').send({ name: 'w', type: 'widget' });
    const id = created.body.id as string;

    const a = await ctx.request.get(`/api/v1/resources/${id}`);
    const b = await ctx.request.get(`/api/v1/resources/${id}`);
    expect(a.headers['x-cache']).toBe('BYPASS');
    expect(b.headers['x-cache']).toBe('BYPASS');
  });

  it('every list GET responds with X-Cache: BYPASS', async () => {
    await ctx.request.post('/api/v1/resources').send({ name: 'a', type: 'widget' });

    const a = await ctx.request.get('/api/v1/resources');
    const b = await ctx.request.get('/api/v1/resources');
    expect(a.headers['x-cache']).toBe('BYPASS');
    expect(b.headers['x-cache']).toBe('BYPASS');
  });
});
