/**
 * Integration test: SSE end-to-end with real NestJS app + Testcontainers
 *
 * Strategy: Boot the full NestJS app with NestFastifyApplication on port 0, then:
 *   1. Obtain a signed JWT (jose is mocked — token format matters, not signature)
 *   2. Open a SSE connection via fetch + ReadableStream
 *   3. Wait for the initial `event: snapshot` frame
 *   4. Insert a leaderboard.updated row into outbox_events
 *   5. Assert the SSE client receives the `leaderboard.updated` frame within 3s
 *
 * Note: jose is ESM-only and mocked at module level to avoid CJS/ESM incompatibility.
 * JWT is built manually. Since jose.jwtVerify is mocked, the fake bearer token passes auth.
 */

// ─── Module-level mocks (must precede any imports) ──────────────────────────

// jose is ESM-only — mock before any import
jest.mock('jose', () => ({
  jwtVerify: jest.fn().mockResolvedValue({
    payload: { sub: 'sse-integration-user' },
  }),
  errors: { JOSEError: class JOSEError extends Error {} },
}));

// OpenTelemetry tracer — avoid gRPC/OTLP side-effects in test
jest.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: () => ({
      startActiveSpan: (_name: string, fn: (span: unknown) => unknown) =>
        fn({ setStatus: jest.fn(), end: jest.fn() }),
    }),
  },
  SpanStatusCode: { ERROR: 'ERROR' },
}));

jest.mock('../../../src/shared/tracing', () => ({
  initTracing: jest.fn().mockResolvedValue(undefined),
}));

// prom-client registers metrics globally — mocking prevents "already registered" errors
// when this test runs after other suites in --runInBand mode.
jest.mock('prom-client', () => {
  const mockMetric = () => ({
    inc: jest.fn(),
    set: jest.fn(),
    observe: jest.fn(),
    startTimer: jest.fn(() => jest.fn()),
    labels: jest.fn(() => ({ inc: jest.fn(), observe: jest.fn() })),
  });
  const MockRegistry = jest.fn(() => ({
    registerMetric: jest.fn(),
    metrics: jest.fn().mockResolvedValue(''),
    contentType: 'text/plain',
    clear: jest.fn(),
    getMetricsAsJSON: jest.fn().mockResolvedValue([]),
  }));
  return {
    Registry: MockRegistry,
    Counter: jest.fn(mockMetric),
    Gauge: jest.fn(mockMetric),
    Histogram: jest.fn(mockMetric),
    register: {
      registerMetric: jest.fn(),
      metrics: jest.fn().mockResolvedValue(''),
      contentType: 'text/plain',
      clear: jest.fn(),
      getMetricsAsJSON: jest.fn().mockResolvedValue([]),
    },
  };
});

import { randomUUID } from 'node:crypto';

import { NatsContainer, StartedNatsContainer } from '@testcontainers/nats';
import {
  NestFastifyApplication,
  FastifyAdapter,
} from '@nestjs/platform-fastify';
import { NestFactory } from '@nestjs/core';
import { connect, type NatsConnection } from 'nats';

import {
  startPostgres,
  startRedis,
  type PostgresHandle,
  type RedisHandle,
} from '../setup';

jest.setTimeout(120_000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

// These match the env vars we'll set before NestJS boots
const INTERNAL_JWT_SECRET = 'supersecretkeythatisatleast32chars!!';
const ACTION_TOKEN_SECRET = 'change-me-to-a-32-byte-random-secret-in-real-env1';

// Build a minimal Bearer token. Since jose.jwtVerify is mocked to always succeed,
// the token content doesn't need to be cryptographically valid — format only.
function buildFakeBearer(): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: 'sse-integration-user',
      iat: Math.floor(Date.now() / 1000),
    }),
  ).toString('base64url');
  return `${header}.${payload}.fake-sig`;
}

function parseSseFrames(text: string): Array<{ event: string; data: string }> {
  const frames: Array<{ event: string; data: string }> = [];
  const blocks = text.split('\n\n').filter((b) => b.trim().length > 0);
  for (const block of blocks) {
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) {
        event = line.slice('event: '.length).trim();
      } else if (line.startsWith('data: ')) {
        data = line.slice('data: '.length).trim();
      }
    }
    if (data) {
      frames.push({ event, data });
    }
  }
  return frames;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SSE end-to-end integration (full NestJS app)', () => {
  let pgHandle: PostgresHandle;
  let redisHandle: RedisHandle;
  let natsContainer: StartedNatsContainer;
  let nc: NatsConnection;
  let app: NestFastifyApplication;
  let appUrl: string;

  beforeAll(async () => {
    // Start containers FIRST so we have real URLs before anything else
    [pgHandle, redisHandle, natsContainer] = await Promise.all([
      startPostgres(),
      startRedis(),
      new NatsContainer('nats:2.10').withJetStream().start(),
    ]);

    // Connect for test use (publishing outbox events via verifying published_at)
    // Do NOT pre-bootstrap the stream — NestJS's StreamBootstrap will create it
    nc = await connect(natsContainer.getConnectionOptions());

    // Set env vars BEFORE loading NestJS modules — ConfigService reads process.env
    process.env['DATABASE_URL'] = pgHandle.url;
    process.env['REDIS_URL'] =
      `redis://${redisHandle.container.getHost()}:${redisHandle.container.getMappedPort(6379)}/0`;
    const opts = natsContainer.getConnectionOptions();
    const natsUser = (opts as { user?: string }).user ?? 'test';
    const natsPass = (opts as { pass?: string }).pass ?? 'test';
    process.env['NATS_URL'] =
      `nats://${natsUser}:${natsPass}@${natsContainer.getHost()}:${natsContainer.getMappedPort(4222)}`;
    process.env['INTERNAL_JWT_SECRET'] = INTERNAL_JWT_SECRET;
    process.env['ACTION_TOKEN_SECRET'] = ACTION_TOKEN_SECRET;
    process.env['OUTBOX_POLL_INTERVAL_MS'] = '50';
    process.env['OUTBOX_COALESCE_WINDOW_MS'] = '100';
    process.env['LOG_LEVEL'] = 'error';
    process.env['NODE_ENV'] = 'test';

    // Dynamic import of AppModule AFTER env vars are set
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../../../src/app.module') as {
      AppModule: new () => unknown;
    };

    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter(),
      { bufferLogs: false },
    );

    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.getHttpServer().address();
    const port = typeof address === 'object' && address ? address.port : 3000;
    appUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app?.close();
    await nc?.drain();
    await natsContainer?.stop();
    await pgHandle?.db.destroy();
    await pgHandle?.container.stop();
    await redisHandle?.client.quit();
    await redisHandle?.container.stop();
  });

  beforeEach(async () => {
    await pgHandle.db.deleteFrom('outbox_events').execute();
    await redisHandle.client.del('outbox:lock');
  });

  // ─── Test 1: Initial snapshot + live update ───────────────────────────────
  test('SSE client receives snapshot then leaderboard.updated frame after outbox insert', async () => {
    const token = buildFakeBearer();
    const abortController = new AbortController();

    const receivedFrames: Array<{ event: string; data: string }> = [];
    let buffer = '';

    const fetchPromise = fetch(`${appUrl}/v1/leaderboard/stream`, {
      headers: { authorization: `Bearer ${token}` },
      signal: abortController.signal,
    })
      .then(async (res) => {
        expect(res.status).toBe(200);
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();

        while (!abortController.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const newFrames = parseSseFrames(buffer);
          receivedFrames.push(...newFrames);
          const lastSep = buffer.lastIndexOf('\n\n');
          if (lastSep !== -1) {
            buffer = buffer.slice(lastSep + 2);
          }
        }
      })
      .catch((err) => {
        if ((err as { name?: string }).name !== 'AbortError') {
          throw err;
        }
      });

    // Wait for the snapshot frame
    const snapshotDeadline = Date.now() + 5_000;
    while (Date.now() < snapshotDeadline) {
      if (receivedFrames.some((f) => f.event === 'snapshot')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(receivedFrames.some((f) => f.event === 'snapshot')).toBe(true);

    // Insert a leaderboard.updated row
    await pgHandle.db
      .insertInto('outbox_events')
      .values({
        aggregate_id: randomUUID(),
        event_type: 'scoreboard.leaderboard.updated',
        payload: JSON.stringify({
          top: [{ rank: 1, userId: 'sse-e2e-user', score: 999 }],
        }) as never,
      })
      .execute();

    // Wait for the leaderboard.updated frame (up to 3s)
    const updateDeadline = Date.now() + 3_000;
    while (Date.now() < updateDeadline) {
      if (receivedFrames.some((f) => f.event === 'leaderboard.updated')) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    abortController.abort();
    await fetchPromise;

    expect(receivedFrames.some((f) => f.event === 'leaderboard.updated')).toBe(
      true,
    );
  });
});
