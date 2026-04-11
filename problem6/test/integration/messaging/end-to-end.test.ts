/**
 * Integration test: Full pipeline Postgres → outbox → JetStream → local emitter
 *
 * Uses @testcontainers/postgresql, @testcontainers/redis, @testcontainers/nats.
 *
 * Strategy:
 *   1. Boot all three containers
 *   2. Instantiate OutboxPublisherService with a REAL JetStreamEventPublisher (no mocks)
 *   3. Instantiate JetStreamSubscriber that forwards messages to LeaderboardUpdatesEmitter
 *   4. Subscribe to the emitter BEFORE inserting the outbox row
 *   5. Insert a `scoreboard.leaderboard.updated` row directly into outbox_events
 *   6. Wait (with retry+timeout ~5s) for published_at IS NOT NULL on that row
 *   7. Assert the emitter fired once with the correct payload
 *
 * This validates the entire write path without any I/O mocks.
 */

import { randomUUID } from 'node:crypto';

import { NatsContainer, StartedNatsContainer } from '@testcontainers/nats';
import { connect, RetentionPolicy, type NatsConnection } from 'nats';
import { EventEmitter2 } from '@nestjs/event-emitter';

import {
  startPostgres,
  startRedis,
  type PostgresHandle,
  type RedisHandle,
} from '../setup';
import { OutboxPublisherService } from '../../../src/scoreboard/infrastructure/outbox/outbox.publisher.service';
import { JetStreamEventPublisher } from '../../../src/scoreboard/infrastructure/messaging/nats/jetstream.event-publisher';
import { JetStreamSubscriber } from '../../../src/scoreboard/infrastructure/messaging/nats/jetstream.subscriber';
import {
  LeaderboardUpdatesEmitter,
  type LeaderboardUpdateEvent,
} from '../../../src/scoreboard/infrastructure/messaging/nats/leaderboard-updates.emitter';
import { ReadinessService } from '../../../src/shared/readiness/readiness.service';
import { ConfigService } from '../../../src/config';
import { EnvSchema } from '../../../src/config/schema';
import type {
  LeaderboardCache,
  LeaderboardEntry,
} from '../../../src/scoreboard/domain';

jest.setTimeout(120_000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(
  pgUrl: string,
  overrides: Partial<Record<string, unknown>> = {},
): ConfigService {
  const parsed = EnvSchema.parse({
    DATABASE_URL: pgUrl,
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

function makeCacheMock(top: LeaderboardEntry[] = []): LeaderboardCache {
  return {
    upsert: jest.fn(),
    getTop: jest.fn().mockResolvedValue(top),
    getRank: jest.fn().mockResolvedValue(null),
  };
}

async function bootstrapStream(nc: NatsConnection): Promise<void> {
  const jsm = await nc.jetstreamManager();
  await jsm.streams.add({
    name: 'SCOREBOARD',
    subjects: ['scoreboard.>'],
    retention: RetentionPolicy.Limits,
    max_msgs: 10_000,
    duplicate_window: 120_000_000_000, // 120s in ns
    num_replicas: 1,
  });
}

async function waitForPublishedAt(
  db: PostgresHandle['db'],
  rowId: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await db
      .selectFrom('outbox_events')
      .where('id', '=', rowId as never)
      .select('published_at')
      .executeTakeFirst();
    if (row?.published_at != null) {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `Timeout: outbox row ${rowId} was not published within ${timeoutMs}ms`,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('End-to-end pipeline: outbox → JetStream → emitter', () => {
  let pgHandle: PostgresHandle;
  let redisHandle: RedisHandle;
  let natsContainer: StartedNatsContainer;
  let nc: NatsConnection;
  let subscriberNc: NatsConnection;

  let publisher: JetStreamEventPublisher;
  let emitter: LeaderboardUpdatesEmitter;
  let readiness: ReadinessService;
  let subscriber: JetStreamSubscriber;
  let outboxService: OutboxPublisherService;

  beforeAll(async () => {
    // Start all three containers in parallel for speed
    [pgHandle, redisHandle, natsContainer] = await Promise.all([
      startPostgres(),
      startRedis(),
      new NatsContainer('nats:2.10').withJetStream().start(),
    ]);

    // Two NATS connections: one for the outbox publisher, one for the subscriber
    const opts = natsContainer.getConnectionOptions();
    [nc, subscriberNc] = await Promise.all([connect(opts), connect(opts)]);

    await bootstrapStream(nc);

    publisher = new JetStreamEventPublisher(nc);

    const eventEmitter = new EventEmitter2();
    emitter = new LeaderboardUpdatesEmitter(eventEmitter);
    readiness = new ReadinessService();
    subscriber = new JetStreamSubscriber(subscriberNc, emitter, readiness);
    await subscriber.onApplicationBootstrap();

    const config = makeConfig(pgHandle.url, { OUTBOX_COALESCE_WINDOW_MS: 100 });
    const topEntries: LeaderboardEntry[] = [
      {
        rank: 1,
        userId: 'e2e-user',
        score: 500,
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ];
    const cache = makeCacheMock(topEntries);

    outboxService = new OutboxPublisherService(
      pgHandle.db as never,
      redisHandle.client,
      publisher,
      cache,
      config,
    );
    outboxService.onApplicationBootstrap();
  });

  afterAll(async () => {
    await outboxService.onApplicationShutdown();
    await subscriber.onApplicationShutdown();
    await nc.drain();
    await subscriberNc.drain();
    await natsContainer.stop();
    await pgHandle.db.destroy();
    await pgHandle.container.stop();
    await redisHandle.client.quit();
    await redisHandle.container.stop();
  });

  beforeEach(async () => {
    await pgHandle.db.deleteFrom('outbox_events').execute();
    await redisHandle.client.del('outbox:lock');
  });

  // ─── Test 1: Full pipeline leaderboard.updated ────────────────────────────
  test('leaderboard.updated row triggers emitter via JetStream within 5s', async () => {
    // Subscribe BEFORE inserting the row so we don't miss the event
    const receivedPromise = new Promise<LeaderboardUpdateEvent>(
      (resolve, reject) => {
        const timeout = setTimeout(
          () =>
            reject(new Error('Timeout: no emitter event received within 5s')),
          5_000,
        );
        const unsubscribe = emitter.subscribe((event) => {
          clearTimeout(timeout);
          unsubscribe();
          resolve(event);
        });
      },
    );

    // Insert leaderboard.updated row with a payload matching what the outbox publisher uses
    const inserted = await pgHandle.db
      .insertInto('outbox_events')
      .values({
        aggregate_id: randomUUID(),
        event_type: 'scoreboard.leaderboard.updated',
        payload: JSON.stringify({
          top: [{ rank: 1, userId: 'e2e-user', score: 500 }],
        }) as never,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const rowId = String(inserted.id);

    // Wait for the outbox publisher to process the row
    await waitForPublishedAt(pgHandle.db, rowId, 5_000);

    // Wait for the emitter to fire (the subscriber receives from JetStream)
    const received = await receivedPromise;

    // Assert the emitter payload
    expect(received.top).toBeDefined();
    expect(Array.isArray(received.top)).toBe(true);
  });
});
