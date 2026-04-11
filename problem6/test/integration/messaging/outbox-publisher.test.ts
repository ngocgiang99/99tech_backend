/**
 * Integration test: OutboxPublisherService
 *
 * Uses real Postgres + Redis testcontainers. The DomainEventPublisher is a jest mock
 * (no NATS required — keeps this test fast and isolated).
 *
 * Covers:
 *   1. Leader acquires Redis lock on bootstrap
 *   2. Publishes unpublished credited rows (1:1)
 *   3. Marks published_at for all processed rows
 *   4. Releases lock on shutdown
 */

import { randomUUID } from 'node:crypto';

import {
  startPostgres,
  startRedis,
  type PostgresHandle,
  type RedisHandle,
} from '../setup';
import { OutboxPublisherService } from '../../../src/scoreboard/infrastructure/outbox/outbox.publisher.service';
import type {
  DomainEvent,
  DomainEventPublisher,
} from '../../../src/scoreboard/domain';
import type {
  LeaderboardCache,
  LeaderboardEntry,
} from '../../../src/scoreboard/domain';
import { ConfigService } from '../../../src/config';
import { EnvSchema } from '../../../src/config/schema';

jest.setTimeout(120_000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(
  overrides: Partial<Record<string, unknown>> = {},
): ConfigService {
  const parsed = EnvSchema.parse({
    DATABASE_URL: 'postgres://test:test@localhost:5432/test', // will be overridden
    REDIS_URL: 'redis://localhost:6379',
    NATS_URL: 'nats://localhost:4222',
    INTERNAL_JWT_SECRET: 'supersecretkeythatisatleast32chars!!',
    ACTION_TOKEN_SECRET: 'supersecretkeythatisatleast32chars!!',
    OUTBOX_POLL_INTERVAL_MS: 50,
    OUTBOX_LOCK_TTL_SECONDS: 10,
    OUTBOX_COALESCE_WINDOW_MS: 100,
    ...overrides,
  });
  return new ConfigService(parsed);
}

function makePublisherMock(): DomainEventPublisher & {
  calls: Array<{ event: DomainEvent; msgId: string }>;
} {
  const calls: Array<{ event: DomainEvent; msgId: string }> = [];
  return {
    calls,
    publish: jest.fn((event: DomainEvent, { msgId }: { msgId: string }) => {
      calls.push({ event, msgId });
      return Promise.resolve();
    }),
  };
}

function makeCacheMock(top: LeaderboardEntry[] = []): LeaderboardCache {
  return {
    upsert: jest.fn(),
    getTop: jest.fn().mockResolvedValue(top),
    getRank: jest.fn().mockResolvedValue(null),
  };
}

async function seedOutboxRows(
  db: PostgresHandle['db'],
  rows: Array<{ eventType: string; payload: Record<string, unknown> }>,
): Promise<string[]> {
  const ids: string[] = [];
  for (const row of rows) {
    const result = await db
      .insertInto('outbox_events')
      .values({
        aggregate_id: randomUUID(),
        event_type: row.eventType,
        payload: JSON.stringify(row.payload) as unknown as never,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    ids.push(String(result.id));
  }
  return ids;
}

function makeService(
  db: PostgresHandle['db'],
  redis: RedisHandle['client'],
  publisher: DomainEventPublisher,
  cache: LeaderboardCache,
  config: ConfigService,
): OutboxPublisherService {
  return new OutboxPublisherService(
    db as never,
    redis,
    publisher,
    cache,
    config,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OutboxPublisherService integration', () => {
  let pgHandle: PostgresHandle;
  let redisHandle: RedisHandle;

  beforeAll(async () => {
    [pgHandle, redisHandle] = await Promise.all([
      startPostgres(),
      startRedis(),
    ]);
  });

  afterAll(async () => {
    await pgHandle.db.destroy();
    await pgHandle.container.stop();
    await redisHandle.client.quit();
    await redisHandle.container.stop();
  });

  beforeEach(async () => {
    // Clean state between tests
    await pgHandle.db.deleteFrom('outbox_events').execute();
    await redisHandle.client.del('outbox:lock');
  });

  // ─── Test 1: Leader acquires Redis lock ──────────────────────────────────
  test('Test 1: leader acquires outbox:lock in Redis on bootstrap', async () => {
    const config = makeConfig({
      DATABASE_URL: pgHandle.url,
      OUTBOX_POLL_INTERVAL_MS: 10_000, // long poll — prevents inner loop from running
    });
    const publisher = makePublisherMock();
    const cache = makeCacheMock();
    const service = makeService(
      pgHandle.db,
      redisHandle.client,
      publisher,
      cache,
      config,
    );

    service.onApplicationBootstrap();

    // Wait briefly for leadership acquisition
    await new Promise((r) => setTimeout(r, 500));

    const lockVal = await redisHandle.client.get('outbox:lock');
    expect(lockVal).toBeTruthy();
    expect(typeof lockVal).toBe('string');

    await service.onApplicationShutdown();
  });

  // ─── Test 2: Publishes unpublished credited rows 1:1 ────────────────────
  test('Test 2: publishes 1 score.credited row — publisher called once with correct payload', async () => {
    const config = makeConfig({
      DATABASE_URL: pgHandle.url,
      OUTBOX_POLL_INTERVAL_MS: 5_000, // prevent multiple loops
      OUTBOX_COALESCE_WINDOW_MS: 1, // tiny window so coalescing resolves immediately
    });
    const publisher = makePublisherMock();
    const cache = makeCacheMock();

    const [creditedId] = await seedOutboxRows(pgHandle.db, [
      {
        eventType: 'scoreboard.score.credited',
        payload: { userId: 'u1', delta: 50 },
      },
    ]);

    const service = makeService(
      pgHandle.db,
      redisHandle.client,
      publisher,
      cache,
      config,
    );
    service.onApplicationBootstrap();

    // Wait for at least one publish batch
    await new Promise((r) => setTimeout(r, 1_000));
    await service.onApplicationShutdown();

    // The credited row should have been published
    expect(
      publisher.calls.filter(
        (c) => c.event.subject === 'scoreboard.score.credited',
      ),
    ).toHaveLength(1);
    const call = publisher.calls.find(
      (c) => c.event.subject === 'scoreboard.score.credited',
    )!;
    expect(call.event.payload).toEqual(
      expect.objectContaining({ userId: 'u1', delta: 50 }),
    );
    expect(call.msgId).toBe(creditedId);
  });

  // ─── Test 3: Sets published_at on processed rows ─────────────────────────
  test('Test 3: sets published_at on successfully processed outbox rows', async () => {
    const config = makeConfig({
      DATABASE_URL: pgHandle.url,
      OUTBOX_POLL_INTERVAL_MS: 5_000,
      OUTBOX_COALESCE_WINDOW_MS: 1,
    });
    const publisher = makePublisherMock();
    const cache = makeCacheMock([]);

    const ids = await seedOutboxRows(pgHandle.db, [
      {
        eventType: 'scoreboard.score.credited',
        payload: { userId: 'u2', delta: 10 },
      },
      {
        eventType: 'scoreboard.score.credited',
        payload: { userId: 'u3', delta: 20 },
      },
    ]);

    const service = makeService(
      pgHandle.db,
      redisHandle.client,
      publisher,
      cache,
      config,
    );
    service.onApplicationBootstrap();
    await new Promise((r) => setTimeout(r, 1_000));
    await service.onApplicationShutdown();

    // All rows should have published_at set
    const rows = await pgHandle.db
      .selectFrom('outbox_events')
      .where('id', 'in', ids as never[])
      .select(['id', 'published_at'])
      .execute();

    for (const row of rows) {
      expect(row.published_at).not.toBeNull();
    }
  });

  // ─── Test 4: Releases lock on shutdown ───────────────────────────────────
  test('Test 4: releases outbox:lock in Redis on shutdown', async () => {
    const config = makeConfig({
      DATABASE_URL: pgHandle.url,
      OUTBOX_POLL_INTERVAL_MS: 10_000, // long poll
    });
    const publisher = makePublisherMock();
    const cache = makeCacheMock();
    const service = makeService(
      pgHandle.db,
      redisHandle.client,
      publisher,
      cache,
      config,
    );

    service.onApplicationBootstrap();
    await new Promise((r) => setTimeout(r, 500)); // let it acquire lock

    // Verify lock is held
    const lockedVal = await redisHandle.client.get('outbox:lock');
    expect(lockedVal).toBeTruthy();

    await service.onApplicationShutdown('SIGTERM');

    // After shutdown, lock should be released
    const afterShutdown = await redisHandle.client.get('outbox:lock');
    expect(afterShutdown).toBeNull();
  });

  // ─── Test 5: Idempotent second shutdown call ────────────────────────────
  test('Test 5: onApplicationShutdown is idempotent on second call', async () => {
    const config = makeConfig({
      DATABASE_URL: pgHandle.url,
      OUTBOX_POLL_INTERVAL_MS: 10_000,
    });
    const publisher = makePublisherMock();
    const cache = makeCacheMock();
    const service = makeService(
      pgHandle.db,
      redisHandle.client,
      publisher,
      cache,
      config,
    );

    service.onApplicationBootstrap();
    await new Promise((r) => setTimeout(r, 500));

    // First shutdown — releases lock
    await service.onApplicationShutdown('SIGTERM');
    const afterFirst = await redisHandle.client.get('outbox:lock');
    expect(afterFirst).toBeNull();

    // Second shutdown — no-op, does not throw
    await expect(
      service.onApplicationShutdown('SIGTERM'),
    ).resolves.toBeUndefined();
    const afterSecond = await redisHandle.client.get('outbox:lock');
    expect(afterSecond).toBeNull();
  });
});
