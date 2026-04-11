/**
 * Integration test: LeaderboardStreamController
 *
 * Strategy: instantiate the controller directly (no NestJS bootstrap) with
 * a mock LeaderboardCache, a real LeaderboardUpdatesInProcessAdapter (backed by EventEmitter2),
 * and a real ConfigService. We drive the request/reply objects with hand-crafted
 * mocks that capture SSE frames.
 *
 * Rationale: Full NestJS + Fastify bootstrap requires NATS, Postgres, and Redis
 * testcontainers — slow and unnecessary. The SSE logic lives entirely in the
 * route handler; the transport layer (Fastify socket) is straightforward to mock.
 *
 * Covers:
 *   1. Connection: correct SSE headers are set, initial snapshot frame sent
 *   2. Live update: emitter.emit() → SSE frame arrives
 *   3. Heartbeat: timer fires writeFrame with event:heartbeat
 *   4. Slow client: buffer fills + TIMEOUT passes → cleanup called
 *   5. Cap exceeded: second connection returns 503
 */

// ─── Module-level mocks ───────────────────────────────────────────────────────

// jose is ESM-only — mock before any import
jest.mock('jose', () => ({
  jwtVerify: jest.fn(),
  errors: { JOSEError: class JOSEError extends Error {} },
}));

// OpenTelemetry tracer
jest.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: () => ({
      startActiveSpan: async (_name: string, fn: (span: unknown) => unknown) =>
        fn({ setStatus: jest.fn(), end: jest.fn() }),
    }),
  },
  SpanStatusCode: { ERROR: 'ERROR' },
}));

import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '../../../src/config';
import { EnvSchema } from '../../../src/config/schema';
import { LeaderboardUpdatesInProcessAdapter } from '../../../src/scoreboard/infrastructure/messaging/nats/leaderboard-updates.emitter';
import type { LeaderboardUpdateEvent } from '../../../src/scoreboard/domain/ports/leaderboard-updates.port';
import { LeaderboardStreamController } from '../../../src/scoreboard/interface/http/controllers/leaderboard-stream.controller';
import type { LeaderboardCache, LeaderboardEntry } from '../../../src/scoreboard/domain';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<Record<string, unknown>> = {}): ConfigService {
  const parsed = EnvSchema.parse({
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    NATS_URL: 'nats://localhost:4222',
    INTERNAL_JWT_SECRET: 'supersecretkeythatisatleast32chars!!',
    ACTION_TOKEN_SECRET: 'supersecretkeythatisatleast32chars!!',
    MAX_SSE_CONN_PER_INSTANCE: 2,
    SSE_BACKPRESSURE_MAX_PENDING_MESSAGES: 50,
    SSE_SLOW_CLIENT_BUFFER_TIMEOUT_MS: 5000,
    SSE_HEARTBEAT_INTERVAL_MS: 15000,
    ...overrides,
  });
  return new ConfigService(parsed);
}

function makeEntry(rank: number, userId: string, score: number): LeaderboardEntry {
  return { rank, userId, score, updatedAt: new Date('2026-01-01T00:00:00Z') };
}

function makeCacheMock(entries: LeaderboardEntry[] = []): LeaderboardCache {
  return {
    upsert: jest.fn(),
    getTop: jest.fn().mockResolvedValue(entries),
    getRank: jest.fn().mockResolvedValue(null),
  };
}

interface MockReply {
  raw: {
    setHeader: jest.Mock;
    flushHeaders: jest.Mock;
    write: jest.Mock;
    end: jest.Mock;
    on: jest.Mock;
    writtenFrames: string[];
    closed: boolean;
  };
  status: (code: number) => MockReply;
  send: jest.Mock;
  _statusCode: number | null;
}

interface MockRequest {
  raw: {
    on: jest.Mock;
  };
  userId?: string;
}

function makeReplyMock(): MockReply {
  const frames: string[] = [];
  const reply: MockReply = {
    _statusCode: null,
    raw: {
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn().mockImplementation((data: string, cb?: (err?: Error | null) => void) => {
        frames.push(data);
        // Call callback immediately (simulate successful write)
        if (typeof cb === 'function') {
          cb(null);
        }
        return true;
      }),
      end: jest.fn().mockImplementation(() => {
        reply.raw.closed = true;
      }),
      on: jest.fn(),
      writtenFrames: frames,
      closed: false,
    },
    status: jest.fn().mockImplementation((code: number) => {
      reply._statusCode = code;
      return reply;
    }),
    send: jest.fn(),
  };
  // Make status a method that returns the reply for chaining
  (reply.status as unknown as (code: number) => MockReply) = (code: number) => {
    reply._statusCode = code;
    return reply;
  };
  return reply;
}

function makeRequestMock(): MockRequest {
  const closeHandlers: Array<() => void> = [];
  const errorHandlers: Array<() => void> = [];
  return {
    raw: {
      on: jest.fn().mockImplementation((event: string, handler: () => void) => {
        if (event === 'close') closeHandlers.push(handler);
        if (event === 'error') errorHandlers.push(handler);
      }),
    },
    userId: 'test-user',
    _closeHandlers: closeHandlers,
    _errorHandlers: errorHandlers,
  } as MockRequest & { _closeHandlers: Array<() => void>; _errorHandlers: Array<() => void> };
}

function resetConnectionCount(): void {
  // Reset the static counter between tests
  (LeaderboardStreamController as never as { currentConnections: number }).currentConnections = 0;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LeaderboardStreamController (SSE)', () => {
  let emitter: LeaderboardUpdatesInProcessAdapter;

  beforeEach(() => {
    jest.useFakeTimers();
    resetConnectionCount();
    const ee = new EventEmitter2();
    emitter = new LeaderboardUpdatesInProcessAdapter(ee);
  });

  afterEach(() => {
    jest.useRealTimers();
    resetConnectionCount();
  });

  // ─── Test 1: Headers + snapshot ──────────────────────────────────────────
  test('Test 1: SSE headers are set and initial snapshot frame is sent', async () => {
    const cache = makeCacheMock([
      makeEntry(1, 'alice', 500),
      makeEntry(2, 'bob', 300),
    ]);
    const config = makeConfig();
    const controller = new LeaderboardStreamController(cache, emitter, config);

    const reply = makeReplyMock();
    const req = makeRequestMock();

    await controller.stream(req as never, reply as never);

    // SSE headers
    expect(reply.raw.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'text/event-stream',
    );
    expect(reply.raw.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    expect(reply.raw.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
    expect(reply.raw.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
    expect(reply.raw.flushHeaders).toHaveBeenCalled();

    // Snapshot frame
    const frames = reply.raw.writtenFrames;
    const snapshotFrame = frames.find((f) => f.includes('event: snapshot'));
    expect(snapshotFrame).toBeDefined();
    expect(snapshotFrame).toContain('"alice"');
  });

  // ─── Test 2: Live update ─────────────────────────────────────────────────
  test('Test 2: emitter.emit() sends leaderboard.updated SSE frame', async () => {
    const cache = makeCacheMock([makeEntry(1, 'alice', 500)]);
    const config = makeConfig();
    const controller = new LeaderboardStreamController(cache, emitter, config);

    const reply = makeReplyMock();
    const req = makeRequestMock();

    await controller.stream(req as never, reply as never);

    // Clear frames recorded so far (snapshot already sent)
    const framesBefore = reply.raw.writtenFrames.length;

    // Fire a live update
    const updateEvent: LeaderboardUpdateEvent = {
      top: [makeEntry(1, 'carol', 999)],
    };
    emitter.emit(updateEvent);

    // Frame should have been added
    const frames = reply.raw.writtenFrames;
    const updatedFrame = frames.slice(framesBefore).find((f) =>
      f.includes('event: leaderboard.updated'),
    );
    expect(updatedFrame).toBeDefined();
    expect(updatedFrame).toContain('"carol"');
  });

  // ─── Test 3: Heartbeat ───────────────────────────────────────────────────
  test('Test 3: heartbeat frame is sent after SSE_HEARTBEAT_INTERVAL_MS', async () => {
    const cache = makeCacheMock([]);
    const config = makeConfig({ SSE_HEARTBEAT_INTERVAL_MS: 15_000 });
    const controller = new LeaderboardStreamController(cache, emitter, config);

    const reply = makeReplyMock();
    const req = makeRequestMock();

    await controller.stream(req as never, reply as never);

    const framesBefore = reply.raw.writtenFrames.length;

    // Advance fake timer by 15s
    jest.advanceTimersByTime(15_000);

    const newFrames = reply.raw.writtenFrames.slice(framesBefore);
    const heartbeatFrame = newFrames.find((f) => f.includes('event: heartbeat'));
    expect(heartbeatFrame).toBeDefined();
  });

  // ─── Test 4: Slow client disconnect ─────────────────────────────────────
  test('Test 4: slow client is disconnected when buffer timeout is exceeded', async () => {
    const MAX_PENDING = 3;
    const TIMEOUT_MS = 500;

    const cache = makeCacheMock([]);
    const config = makeConfig({
      SSE_BACKPRESSURE_MAX_PENDING_MESSAGES: MAX_PENDING,
      SSE_SLOW_CLIENT_BUFFER_TIMEOUT_MS: TIMEOUT_MS,
      SSE_HEARTBEAT_INTERVAL_MS: 60_000, // don't fire heartbeats
    });
    const controller = new LeaderboardStreamController(cache, emitter, config);

    const reply = makeReplyMock();
    // Simulate a slow client: write() callback is NEVER called (backpressure)
    reply.raw.write = jest.fn().mockImplementation((data: string) => {
      reply.raw.writtenFrames.push(data);
      // NO callback invoked — simulates slow client where write never drains
      return false;
    });

    const req = makeRequestMock();
    await controller.stream(req as never, reply as never);

    // Fill the buffer beyond MAX_PENDING
    for (let i = 0; i < MAX_PENDING + 2; i++) {
      emitter.emit({ top: [makeEntry(1, `user-${i}`, 100)] });
    }

    // Advance time past timeout — slow-client timer should trigger cleanup
    jest.advanceTimersByTime(TIMEOUT_MS + 1_100); // +1100ms for the 1s slow-client tick

    // Connection should be closed
    expect(reply.raw.end).toHaveBeenCalled();
  });

  // ─── Test 5: Cap exceeded → 503 ─────────────────────────────────────────
  test('Test 5: second connection returns 503 when MAX_SSE_CONN_PER_INSTANCE=1', async () => {
    const cache = makeCacheMock([makeEntry(1, 'alice', 100)]);
    const config = makeConfig({ MAX_SSE_CONN_PER_INSTANCE: 1 });
    const controller = new LeaderboardStreamController(cache, emitter, config);

    const reply1 = makeReplyMock();
    const req1 = makeRequestMock();
    // First connection — should succeed
    await controller.stream(req1 as never, reply1 as never);

    // Second connection — should 503
    const reply2 = makeReplyMock();
    const req2 = makeRequestMock();
    await controller.stream(req2 as never, reply2 as never);

    expect(reply2._statusCode).toBe(503);
    expect(reply2.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'TEMPORARILY_UNAVAILABLE' }),
      }),
    );
  });
});
