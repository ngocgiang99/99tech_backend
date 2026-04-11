/**
 * Integration test: OutboxPublisherService — coalescing behaviour
 *
 * Uses real Postgres + Redis testcontainers. DomainEventPublisher is a mock.
 *
 * Covers:
 *   1. Burst (50 leaderboard.updated rows) → exactly 1 publish call
 *   2. No-op skipping: same top-10 → publisher NOT called
 *   3. Change detection: different top-10 → publisher called once
 */

import { randomUUID } from 'node:crypto';

import { startPostgres, startRedis, type PostgresHandle, type RedisHandle } from '../setup';
import { OutboxPublisherService } from '../../../src/scoreboard/infrastructure/outbox/outbox.publisher.service';
import type { DomainEvent, DomainEventPublisher, LeaderboardCache, LeaderboardEntry } from '../../../src/scoreboard/domain';
import { ConfigService } from '../../../src/config';
import { EnvSchema } from '../../../src/config/schema';

jest.setTimeout(120_000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<Record<string, unknown>> = {}): ConfigService {
  const parsed = EnvSchema.parse({
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
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
    publish: jest.fn(async (event: DomainEvent, { msgId }: { msgId: string }) => {
      calls.push({ event, msgId });
    }),
  };
}

function makeTop10(seed: number): LeaderboardEntry[] {
  return Array.from({ length: 10 }, (_, i) => ({
    rank: i + 1,
    userId: `user-${seed}-${i}`,
    score: (10 - i) * 100 + seed,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  }));
}

function makeCacheMock(top: LeaderboardEntry[]): LeaderboardCache {
  return {
    upsert: jest.fn(),
    getTop: jest.fn().mockResolvedValue(top),
    getRank: jest.fn().mockResolvedValue(null),
  };
}

async function seedLeaderboardRows(
  db: PostgresHandle['db'],
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await db
      .insertInto('outbox_events')
      .values({
        aggregate_id: randomUUID(),
        event_type: 'scoreboard.leaderboard.updated',
        payload: JSON.stringify({ seq: i }) as unknown as never,
      })
      .execute();
  }
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

describe('OutboxPublisherService — coalescing', () => {
  let pgHandle: PostgresHandle;
  let redisHandle: RedisHandle;

  beforeAll(async () => {
    [pgHandle, redisHandle] = await Promise.all([startPostgres(), startRedis()]);
  });

  afterAll(async () => {
    await pgHandle.db.destroy();
    await pgHandle.container.stop();
    await redisHandle.client.quit();
    await redisHandle.container.stop();
  });

  beforeEach(async () => {
    await pgHandle.db.deleteFrom('outbox_events').execute();
    await redisHandle.client.del('outbox:lock');
  });

  // ─── Test 1: Burst → exactly 1 publish ───────────────────────────────────
  test('Test 1: 50 leaderboard.updated rows → exactly 1 publish call (coalescing)', async () => {
    // Small coalescing window — all 50 rows fall in one window
    const config = makeConfig({
      DATABASE_URL: pgHandle.url,
      OUTBOX_POLL_INTERVAL_MS: 50,
      OUTBOX_COALESCE_WINDOW_MS: 5_000, // 5s window — all rows batched together
    });

    const top10 = makeTop10(1);
    const publisher = makePublisherMock();
    const cache = makeCacheMock(top10); // different from null (initial) → will publish

    await seedLeaderboardRows(pgHandle.db, 50);

    const service = makeService(pgHandle.db, redisHandle.client, publisher, cache, config);
    service.onApplicationBootstrap();

    // Wait for one poll cycle to accumulate rows
    await new Promise((r) => setTimeout(r, 300));

    // Force window boundary by waiting for the coalescing window to pass
    // The service tracks lastWindow; we need currentWindow != lastWindow
    // We seed rows, then wait > OUTBOX_COALESCE_WINDOW_MS for the next window
    await new Promise((r) => setTimeout(r, 5_500));

    await service.onApplicationShutdown();

    const leaderboardCalls = publisher.calls.filter(
      (c) => c.event.subject === 'scoreboard.leaderboard.updated',
    );
    // Should be exactly 1 despite 50 rows
    expect(leaderboardCalls.length).toBe(1);
  });

  // ─── Test 2: No-op skipping — same top-10 → no publish ──────────────────
  test('Test 2: same top-10 → publisher NOT called for leaderboard.updated', async () => {
    const config = makeConfig({
      DATABASE_URL: pgHandle.url,
      OUTBOX_POLL_INTERVAL_MS: 50,
      OUTBOX_COALESCE_WINDOW_MS: 200, // short window
    });

    const top10 = makeTop10(42);
    const publisher = makePublisherMock();

    // Return the SAME top-10 every call
    const cache = makeCacheMock(top10);

    await seedLeaderboardRows(pgHandle.db, 5);

    const service = makeService(pgHandle.db, redisHandle.client, publisher, cache, config);

    // Manually set lastPublishedTop10 to match what cache will return
    // so the service sees "no change"
    // We access via bracket notation to set the private field
    (service as never as { lastPublishedTop10: string | null }).lastPublishedTop10 =
      JSON.stringify(top10);

    service.onApplicationBootstrap();

    // Wait for one full poll cycle + coalescing window
    await new Promise((r) => setTimeout(r, 800));
    await service.onApplicationShutdown();

    const leaderboardCalls = publisher.calls.filter(
      (c) => c.event.subject === 'scoreboard.leaderboard.updated',
    );
    // Same top-10 → no publish
    expect(leaderboardCalls.length).toBe(0);

    // But rows should still be marked published_at (processed as no-op)
    const unpublished = await pgHandle.db
      .selectFrom('outbox_events')
      .where('published_at', 'is', null)
      .where('event_type', '=', 'scoreboard.leaderboard.updated')
      .selectAll()
      .execute();
    expect(unpublished).toHaveLength(0);
  });

  // ─── Test 3: Change detection → publisher called once ────────────────────
  test('Test 3: different top-10 → publisher called exactly once', async () => {
    const config = makeConfig({
      DATABASE_URL: pgHandle.url,
      OUTBOX_POLL_INTERVAL_MS: 50,
      OUTBOX_COALESCE_WINDOW_MS: 200,
    });

    const top10v1 = makeTop10(1);
    const top10v2 = makeTop10(2); // Different

    const publisher = makePublisherMock();
    // Cache returns v2 (different from initially-set v1)
    const cache = makeCacheMock(top10v2);

    await seedLeaderboardRows(pgHandle.db, 3);

    const service = makeService(pgHandle.db, redisHandle.client, publisher, cache, config);

    // Set lastPublishedTop10 to v1 → cache will return v2 → change detected
    (service as never as { lastPublishedTop10: string | null }).lastPublishedTop10 =
      JSON.stringify(top10v1);

    service.onApplicationBootstrap();

    // Wait for poll cycle + coalescing window boundary
    await new Promise((r) => setTimeout(r, 800));
    await service.onApplicationShutdown();

    const leaderboardCalls = publisher.calls.filter(
      (c) => c.event.subject === 'scoreboard.leaderboard.updated',
    );
    expect(leaderboardCalls.length).toBe(1);
  });
});
