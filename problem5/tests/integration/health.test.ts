import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestAppContext } from './fixtures/app.js';

describe('GET /healthz', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('returns 200 with both db and cache up when dependencies are reachable', async () => {
    const res = await ctx.request.get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks.db.status).toBe('up');
    expect(res.body.checks.cache.status).toBe('up');
  });

  it('liveness-only probe returns 200 and omits downstream checks', async () => {
    const res = await ctx.request.get('/healthz?probe=liveness');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.probe).toBe('liveness');
  });
});
