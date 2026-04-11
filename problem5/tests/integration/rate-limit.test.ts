/**
 * Integration test for s12-add-rate-limit-middleware.
 *
 * Brings up the full Express app via the Testcontainers fixture and exercises
 * the five scenarios the spec demands:
 *
 *   1. Limiter fires from a non-loopback peer (spoofed via X-Forwarded-For,
 *      which supertest is allowed to send because its TCP peer is loopback
 *      and `trust proxy` trusts the loopback hop).
 *   2. Loopback bypass holds — no X-Forwarded-For means req.ip === 127.0.0.1
 *      and the limiter skips the bucket entirely.
 *   3. /healthz is excluded — heavy /healthz traffic from a non-loopback peer
 *      does not consume the /resources bucket.
 *   4. 429 body is leak-free — shares the error-handling allowlist.
 *   5. RATE_LIMIT_ENABLED=false disables the middleware.
 *
 * The test file deliberately spins up multiple app instances with different
 * env overrides. Each `createTestApp` builds a fresh Express app from
 * createApp(deps), so config changes land immediately without needing a
 * separate DI path.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestAppContext } from './fixtures/app.js';
import { flushCache, resetDatabase } from './fixtures/db.js';

// The non-loopback peer we spoof via X-Forwarded-For. Chosen from the
// TEST-NET-3 documentation block (RFC 5737) so it cannot clash with any
// real network and is recognizably "public" in log output.
const NON_LOOPBACK_IP = '203.0.113.5';

const LEAK_DENYLIST = [
  'at /',
  'pg:',
  'kysely',
  'ioredis',
  'node_modules',
  'stack',
  'SELECT ',
  'INSERT ',
  'UPDATE ',
  'DELETE ',
  'FROM ',
  'WHERE ',
] as const;

function assertNoLeak(body: unknown): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  for (const indicator of LEAK_DENYLIST) {
    expect(text, `Response must not contain leak indicator "${indicator}"`).not.toContain(
      indicator,
    );
  }
}

// ---------------------------------------------------------------------------
// Suite 1 — limiter ENABLED, low RATE_LIMIT_MAX for fast assertion
// ---------------------------------------------------------------------------

describe('rate-limit middleware — enabled, MAX=5', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp({
      RATE_LIMIT_ENABLED: 'true',
      RATE_LIMIT_MAX: '5',
      RATE_LIMIT_WINDOW_MS: '60000',
      RATE_LIMIT_ALLOWLIST_CIDRS: '',
    });
  });

  afterEach(async () => {
    await resetDatabase(ctx.deps.db);
    await flushCache(ctx.deps.redis);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('limiter fires on the 6th request from a non-loopback peer', async () => {
    const responses = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await ctx.request
        .get('/resources')
        .set('X-Forwarded-For', NON_LOOPBACK_IP);
      responses.push(res);
    }

    // First 5 should be 200 (under limit).
    for (let i = 0; i < 5; i += 1) {
      expect(responses[i]?.status, `request ${i} expected 200`).toBe(200);
    }

    // 6th should be 429 with the canonical envelope shape and a Retry-After.
    const last = responses[5]!;
    expect(last.status).toBe(429);
    expect(last.body).toMatchObject({
      error: {
        code: 'RATE_LIMIT',
        message: expect.any(String),
        requestId: expect.any(String),
      },
    });
    expect(last.headers['retry-after']).toBeDefined();
    expect(Number(last.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('429 response body is leak-free (no SQL fragments, stacks, or library names)', async () => {
    // Burn through the bucket so the next request fires the 429.
    for (let i = 0; i < 5; i += 1) {
      await ctx.request.get('/resources').set('X-Forwarded-For', NON_LOOPBACK_IP);
    }
    const res = await ctx.request
      .get('/resources')
      .set('X-Forwarded-For', NON_LOOPBACK_IP);

    expect(res.status).toBe(429);
    assertNoLeak(res.body);
    // Confirm the response does NOT leak internal fields.
    expect(res.body.error).not.toHaveProperty('stack');
    expect(res.body.error).not.toHaveProperty('errorId');
  });

  it('loopback bypass holds — 12 requests with no X-Forwarded-For all succeed', async () => {
    for (let i = 0; i < 12; i += 1) {
      const res = await ctx.request.get('/resources');
      expect(res.status, `request ${i} expected non-429`).not.toBe(429);
    }
  });

  it('/healthz is excluded — 50 /healthz requests do not consume the bucket', async () => {
    // Hammer /healthz from a non-loopback peer. The limiter must skip these.
    for (let i = 0; i < 50; i += 1) {
      const res = await ctx.request
        .get('/healthz?probe=liveness')
        .set('X-Forwarded-For', NON_LOOPBACK_IP);
      expect(res.status).toBe(200);
    }

    // Now issue 6 /resources requests from the same peer. The first 5 should
    // succeed (bucket is untouched by /healthz) and the 6th should be 429.
    const results = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await ctx.request
        .get('/resources')
        .set('X-Forwarded-For', NON_LOOPBACK_IP);
      results.push(res.status);
    }
    expect(results.filter((s) => s === 200)).toHaveLength(5);
    expect(results[5]).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — limiter DISABLED via config
// ---------------------------------------------------------------------------

describe('rate-limit middleware — disabled via RATE_LIMIT_ENABLED=false', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp({
      RATE_LIMIT_ENABLED: 'false',
      RATE_LIMIT_MAX: '5',
      RATE_LIMIT_WINDOW_MS: '60000',
    });
  });

  afterEach(async () => {
    await resetDatabase(ctx.deps.db);
    await flushCache(ctx.deps.redis);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('100 requests from a non-loopback peer all succeed with no 429s', async () => {
    let successCount = 0;
    for (let i = 0; i < 100; i += 1) {
      const res = await ctx.request
        .get('/resources')
        .set('X-Forwarded-For', NON_LOOPBACK_IP);
      expect(res.status, `request ${i} expected 200, got ${res.status}`).toBe(200);
      successCount += 1;
    }
    expect(successCount).toBe(100);
  });
});
