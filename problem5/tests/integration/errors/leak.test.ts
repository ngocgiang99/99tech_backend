/**
 * Integration leak test — Section 10 of tasks.md.
 *
 * Boots a real test app via Testcontainers (DATABASE_URL / REDIS_URL are set
 * by the global setup in fixtures/containers.ts) and asserts that NONE of the
 * defined leak indicators appear in any HTTP error response body.
 *
 * Test cases:
 *   1. POST with invalid body → 400, body is clean
 *   2. GET non-existent UUID id → 404, body is clean
 *   3. Forced 500 via stub repository → 500, body is clean, body has errorId
 *   4. errorId in response equals errorId in the captured log entry
 */

import { Writable } from 'node:stream';

import express from 'express';
import pino from 'pino';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../../src/config/env.js';
import { createRedis } from '../../../src/infrastructure/cache/client.js';
import { createDb } from '../../../src/infrastructure/db/client.js';
import { createErrorHandler } from '../../../src/middleware/error-handler.js';
import { requestIdMiddleware } from '../../../src/middleware/request-id.js';
import { InternalError } from '../../../src/shared/errors.js';
import type { ResourceRepository } from '../../../src/modules/resources/infrastructure/repository.js';

import { createTestApp, type TestAppContext } from '../fixtures/app.js';
import { flushCache, resetDatabase } from '../fixtures/db.js';

// ---------------------------------------------------------------------------
// Denylist — none of these strings may appear in any public error response body
// ---------------------------------------------------------------------------
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
// Standard test app (cases 1 + 2)
// ---------------------------------------------------------------------------
describe('Response leak check — standard error paths', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  afterAll(async () => {
    await resetDatabase(ctx.deps.db);
    await flushCache(ctx.deps.redis);
  });

  it('case 1: POST invalid body → 400, no leak indicators in response', async () => {
    const res = await ctx.request
      .post('/resources')
      .set('Content-Type', 'application/json')
      .send('not-json-at-all');

    expect(res.status).toBe(400);
    assertNoLeak(res.body);
    // Confirm the response has exactly the allowed shape
    expect(res.body).toHaveProperty('error.code');
    expect(res.body).toHaveProperty('error.message');
    expect(res.body).toHaveProperty('error.requestId');
    expect(res.body.error).not.toHaveProperty('stack');
    expect(res.body.error).not.toHaveProperty('errorId');
  });

  it('case 2: GET non-existent id → 404, no leak indicators in response', async () => {
    const res = await ctx.request.get(
      '/resources/99999999-9999-9999-9999-999999999999',
    );

    expect(res.status).toBe(404);
    assertNoLeak(res.body);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error).not.toHaveProperty('stack');
    expect(res.body.error).not.toHaveProperty('errorId');
  });
});

// ---------------------------------------------------------------------------
// Forced-500 test app (cases 3 + 4)
// Builds a minimal Express app with a stub repository that throws a fake pg
// error, wired to a capturing pino logger so we can read the log entries.
// ---------------------------------------------------------------------------

/** Captured ndjson log lines. */
interface LogLine {
  level: number;
  err?: {
    errorId?: string;
    code?: string;
    status?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function makeFakePgError(code: string): unknown {
  return { name: 'error', code, message: `Fake pg error ${code}` };
}

/** Repository stub where every method throws a fake pg error (XX000 → InternalError via mapper). */
function makeFailingRepo(): ResourceRepository {
  const fakePgErr = makeFakePgError('XX000');
  const boom = new InternalError('Forced internal error', { cause: fakePgErr });
  return {
    create: async () => { throw boom; },
    findById: async () => { throw boom; },
    list: async () => { throw boom; },
    update: async () => { throw boom; },
    delete: async () => { throw boom; },
  };
}

describe('Response leak check — forced 500 path', () => {
  let request: ReturnType<typeof supertest>;
  let logLines: LogLine[];
  let redis: ReturnType<typeof createRedis>;
  let pool: ReturnType<typeof createDb>['pool'];

  beforeAll(async () => {
    logLines = [];

    // In-memory pino stream: collect JSON log lines into `logLines`
    const logStream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        try {
          const line = JSON.parse(chunk.toString()) as LogLine;
          logLines.push(line);
        } catch {
          // ignore malformed lines
        }
        cb();
      },
    });

    const captureLogger = pino({ level: 'error' }, logStream);

    // Wire real DB + Redis (Testcontainers)
    const config = loadConfig();
    const result = createDb({
      connectionString: config.DATABASE_URL,
      maxConnections: config.DB_POOL_MAX,
    });
    pool = result.pool;

    redis = createRedis({ url: config.REDIS_URL });
    if (redis.status !== 'ready') {
      await new Promise<void>((resolve, reject) => {
        const onReady = (): void => { redis.off('error', onError); resolve(); };
        const onError = (err: Error): void => { redis.off('ready', onReady); reject(err); };
        redis.once('ready', onReady);
        redis.once('error', onError);
      });
    }

    // Build a minimal app with the stub repository injected directly
    const app = express();
    app.use(requestIdMiddleware);
    app.use(express.json({ limit: '64kb' }));

    const failingRepo = makeFailingRepo();
    // createResourcesModule wires the repo internally from `db`, so we
    // bypass it and build our own service + controller + router with the stub:
    const { ResourceService } = await import('../../../src/modules/resources/application/service.js');
    const { createResourceController } = await import('../../../src/modules/resources/presentation/controller.js');
    const { createResourcesRouter } = await import('../../../src/modules/resources/presentation/router.js');

    const service = new ResourceService(failingRepo);
    const ctrl = createResourceController(service, { cacheEnabled: false });
    const router = createResourcesRouter(ctrl, 'test');

    app.use('/resources', router);
    app.use(createErrorHandler(captureLogger));

    request = supertest(app);
  });

  afterAll(async () => {
    try { await redis.quit(); } catch { redis.disconnect(); }
    await pool.end();
  });

  it('case 3: forced 500 → no leak indicators, response has errorId UUID', async () => {
    const res = await request.get(
      '/resources/11111111-1111-1111-1111-111111111111',
    );

    expect(res.status).toBe(500);
    assertNoLeak(res.body);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(res.body.error.message).toBe('Internal server error');
    expect(res.body.error).not.toHaveProperty('stack');
    // errorId must be present and a valid UUID
    expect(res.body.error.errorId).toBeDefined();
    expect(res.body.error.errorId as string).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('case 4: errorId in response equals errorId in the captured log entry', async () => {
    logLines = []; // reset before this test

    const res = await request.get(
      '/resources/22222222-2222-2222-2222-222222222222',
    );

    expect(res.status).toBe(500);
    const responseErrorId = res.body.error.errorId as string;
    expect(responseErrorId).toBeDefined();

    // The logger emits: logger.error({ err: metadata }, 'Request error')
    // buildErrorMetadata includes errorId in the metadata payload
    const errorLogLine = logLines.find(
      (line) => line.level === 50 && typeof line['err'] === 'object',
    );
    expect(errorLogLine, 'Expected at least one error-level log entry').toBeDefined();

    const loggedErrorId = (errorLogLine?.['err'] as Record<string, unknown>)?.['errorId'];
    expect(
      loggedErrorId,
      'errorId in log entry must match errorId in response',
    ).toBe(responseErrorId);
  });
});
