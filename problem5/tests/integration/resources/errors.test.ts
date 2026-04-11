import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestAppContext } from '../fixtures/app.js';
import { flushCache, resetDatabase } from '../fixtures/db.js';

describe('resources error paths', () => {
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

  it('POST with an unknown field returns 400 VALIDATION', async () => {
    const res = await ctx.request
      .post('/resources')
      .send({ name: 'x', type: 'widget', bogusField: 'boom' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(res.body.error.requestId).toBeDefined();
  });

  it('POST with malformed JSON returns 400 VALIDATION', async () => {
    const res = await ctx.request
      .post('/resources')
      .set('Content-Type', 'application/json')
      .send('{"name": "x", "type": ');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(res.body.error.message).toMatch(/JSON/i);
  });

  it('POST exceeding the 64 KB body limit returns 400 VALIDATION', async () => {
    const fat = { name: 'x', type: 'widget', metadata: { payload: 'a'.repeat(100_000) } };
    const res = await ctx.request.post('/resources').send(fat);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('GET /resources/:id with a non-UUID id returns 400 VALIDATION', async () => {
    const res = await ctx.request.get('/resources/not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('PATCH with id in body returns 400 VALIDATION', async () => {
    const created = await ctx.request
      .post('/resources')
      .send({ name: 'r', type: 'widget' });

    const res = await ctx.request
      .patch(`/resources/${created.body.id as string}`)
      .send({ id: 'different' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('PATCH with createdAt in body returns 400 VALIDATION', async () => {
    const created = await ctx.request
      .post('/resources')
      .send({ name: 'r', type: 'widget' });

    const res = await ctx.request
      .patch(`/resources/${created.body.id as string}`)
      .send({ createdAt: '2020-01-01T00:00:00Z' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('PATCH on a non-existent id returns 404 NOT_FOUND', async () => {
    const id = '22222222-2222-2222-2222-222222222222';
    const res = await ctx.request.patch(`/resources/${id}`).send({ status: 'archived' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('DELETE on a non-existent id returns 404 NOT_FOUND', async () => {
    const id = '33333333-3333-3333-3333-333333333333';
    const res = await ctx.request.delete(`/resources/${id}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('error responses echo the X-Request-Id header', async () => {
    const res = await ctx.request
      .get('/resources/not-a-uuid')
      .set('X-Request-Id', 'test-req-42');

    expect(res.status).toBe(400);
    expect(res.headers['x-request-id']).toBe('test-req-42');
    expect(res.body.error.requestId).toBe('test-req-42');
  });
});
