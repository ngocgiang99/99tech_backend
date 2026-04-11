import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestAppContext } from '../fixtures/app.js';
import { flushCache, resetDatabase } from '../fixtures/db.js';

interface ResourceDto {
  id: string;
  name: string;
  type: string;
  status: string;
  tags: string[];
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ListResponse {
  data: ResourceDto[];
  nextCursor: string | null;
}

async function seed(
  ctx: TestAppContext,
  payloads: Array<Record<string, unknown>>,
): Promise<ResourceDto[]> {
  const results: ResourceDto[] = [];
  for (const p of payloads) {
    const res = await ctx.request.post('/resources').send(p);
    results.push(res.body as ResourceDto);
    // Tiny delay to ensure distinct created_at timestamps for ordering assertions.
    await new Promise((r) => setTimeout(r, 5));
  }
  return results;
}

describe('resources list', () => {
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

  it('unfiltered list returns newest first', async () => {
    await seed(ctx, [
      { name: 'r1', type: 'widget' },
      { name: 'r2', type: 'widget' },
      { name: 'r3', type: 'widget' },
    ]);

    const res = await ctx.request.get('/resources');
    expect(res.status).toBe(200);
    const body = res.body as ListResponse;
    expect(body.data.map((r) => r.name)).toEqual(['r3', 'r2', 'r1']);
    expect(body.nextCursor).toBeNull();
  });

  it('filters by type exact match', async () => {
    await seed(ctx, [
      { name: 'w1', type: 'widget' },
      { name: 'w2', type: 'widget' },
      { name: 'g1', type: 'gadget' },
    ]);

    const res = await ctx.request.get('/resources?type=gadget');
    const body = res.body as ListResponse;
    expect(body.data.map((r) => r.name)).toEqual(['g1']);
  });

  it('filters by multiple statuses (OR)', async () => {
    await seed(ctx, [
      { name: 'a', type: 'widget', status: 'active' },
      { name: 'b', type: 'widget', status: 'pending' },
      { name: 'c', type: 'widget', status: 'archived' },
    ]);

    const res = await ctx.request.get('/resources?status=active&status=pending');
    const body = res.body as ListResponse;
    expect(body.data.map((r) => r.status).sort()).toEqual(['active', 'pending']);
  });

  it('filters by multiple tags (AND)', async () => {
    await seed(ctx, [
      { name: 'both', type: 'widget', tags: ['red', 'urgent'] },
      { name: 'red-only', type: 'widget', tags: ['red'] },
      { name: 'urgent-only', type: 'widget', tags: ['urgent'] },
    ]);

    const res = await ctx.request.get('/resources?tag=red&tag=urgent');
    const body = res.body as ListResponse;
    expect(body.data.map((r) => r.name)).toEqual(['both']);
  });

  it('filters by ownerId', async () => {
    const ownerId = '11111111-1111-1111-1111-111111111111';
    await seed(ctx, [
      { name: 'mine', type: 'widget', ownerId },
      { name: 'other', type: 'widget' },
    ]);

    const res = await ctx.request.get(`/resources?ownerId=${ownerId}`);
    const body = res.body as ListResponse;
    expect(body.data.map((r) => r.name)).toEqual(['mine']);
  });

  it('filters by createdAfter / createdBefore window', async () => {
    await seed(ctx, [
      { name: 'w1', type: 'widget' },
      { name: 'w2', type: 'widget' },
      { name: 'w3', type: 'widget' },
    ]);

    // Inclusive lower bound, exclusive upper bound. Use very wide window
    // for smoke-test simplicity.
    const after = '2020-01-01T00:00:00.000Z';
    const before = '2099-12-31T23:59:59.999Z';
    const res = await ctx.request.get(
      `/resources?createdAfter=${after}&createdBefore=${before}`,
    );
    const body = res.body as ListResponse;
    expect(body.data.length).toBe(3);
  });

  it('paginates via keyset cursor with no duplicates across pages', async () => {
    await seed(
      ctx,
      Array.from({ length: 12 }, (_, i) => ({ name: `r${i}`, type: 'widget' })),
    );

    const page1 = await ctx.request.get('/resources?limit=5');
    const body1 = page1.body as ListResponse;
    expect(body1.data.length).toBe(5);
    expect(body1.nextCursor).not.toBeNull();

    const page2 = await ctx.request.get(
      `/resources?limit=5&cursor=${encodeURIComponent(body1.nextCursor ?? '')}`,
    );
    const body2 = page2.body as ListResponse;
    expect(body2.data.length).toBe(5);
    expect(body2.nextCursor).not.toBeNull();

    const page3 = await ctx.request.get(
      `/resources?limit=5&cursor=${encodeURIComponent(body2.nextCursor ?? '')}`,
    );
    const body3 = page3.body as ListResponse;
    expect(body3.data.length).toBe(2);
    expect(body3.nextCursor).toBeNull();

    const allIds = [
      ...body1.data.map((r) => r.id),
      ...body2.data.map((r) => r.id),
      ...body3.data.map((r) => r.id),
    ];
    const uniqueIds = new Set(allIds);
    expect(uniqueIds.size).toBe(12);
  });

  it('rejects an invalid cursor', async () => {
    const res = await ctx.request.get('/resources?cursor=not-a-cursor');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('rejects limit > 100', async () => {
    const res = await ctx.request.get('/resources?limit=101');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });
});
