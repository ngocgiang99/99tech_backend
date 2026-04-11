/**
 * Integration test: JetStreamSubscriber
 *
 * Uses @testcontainers/nats. Boots the SCOREBOARD stream, instantiates
 * JetStreamSubscriber, and verifies:
 *   1. Ephemeral consumer is created on bootstrap
 *   2. Messages published to scoreboard.leaderboard.updated are delivered via emitter
 *   3. Consumer is destroyed on shutdown
 */

import { NatsContainer, StartedNatsContainer } from '@testcontainers/nats';
import {
  connect,
  JSONCodec,
  RetentionPolicy,
  type NatsConnection,
} from 'nats';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { JetStreamSubscriber } from '../../../src/scoreboard/infrastructure/messaging/nats/jetstream.subscriber';
import { LeaderboardUpdatesInProcessAdapter } from '../../../src/scoreboard/infrastructure/messaging/nats/leaderboard-updates.emitter';
import type { LeaderboardUpdateEvent } from '../../../src/scoreboard/domain/ports/leaderboard-updates.port';
import { ReadinessService } from '../../../src/shared/readiness/readiness.service';

jest.setTimeout(120_000);

const codec = JSONCodec<LeaderboardUpdateEvent>();

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

describe('JetStreamSubscriber integration', () => {
  let container: StartedNatsContainer;
  let nc: NatsConnection;
  let publisherNc: NatsConnection;
  let emitter: LeaderboardUpdatesInProcessAdapter;
  let readiness: ReadinessService;
  let subscriber: JetStreamSubscriber;

  beforeAll(async () => {
    container = await new NatsContainer('nats:2.10')
      .withJetStream()
      .start();

    const opts = container.getConnectionOptions();
    [nc, publisherNc] = await Promise.all([connect(opts), connect(opts)]);

    await bootstrapStream(nc);

    const eventEmitter = new EventEmitter2();
    emitter = new LeaderboardUpdatesInProcessAdapter(eventEmitter);
    readiness = new ReadinessService();

    subscriber = new JetStreamSubscriber(nc, emitter, readiness);
    await subscriber.onApplicationBootstrap();
  });

  afterAll(async () => {
    await subscriber.onApplicationShutdown();
    await nc.drain();
    await publisherNc.drain();
    await container.stop();
  });

  // ─── Test 1: Ephemeral consumer is created ───────────────────────────────
  test('Test 1: ephemeral consumer is created in SCOREBOARD stream on bootstrap', async () => {
    const jsm = await nc.jetstreamManager();
    const consumers: string[] = [];
    for await (const info of jsm.consumers.list('SCOREBOARD')) {
      consumers.push(info.name);
    }
    expect(consumers.length).toBeGreaterThan(0);
    expect(readiness.jetstreamReady).toBe(true);
  });

  // ─── Test 2: Message delivered via local emitter ─────────────────────────
  test('Test 2: publishing leaderboard.updated message is delivered to LeaderboardUpdatesInProcessAdapter', async () => {
    const testEvent: LeaderboardUpdateEvent = {
      top: [
        {
          rank: 1,
          userId: 'user-abc',
          score: 999,
          updatedAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
    };

    // Set up emitter subscription BEFORE publishing
    const receivedPromise = new Promise<LeaderboardUpdateEvent>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Timeout: no emitter event received')),
        15_000,
      );

      const unsubscribe = emitter.subscribe((event) => {
        clearTimeout(timeout);
        unsubscribe();
        resolve(event);
      });
    });

    // Publish AFTER subscription is established
    const js = publisherNc.jetstream();
    await js.publish(
      'scoreboard.leaderboard.updated',
      codec.encode(testEvent),
    );

    // Wait for the emitter to fire
    const received = await receivedPromise;

    expect(received.top).toBeDefined();
    expect(received.top[0].userId).toBe('user-abc');
  });

  // ─── Test 3: Consumer destroyed on shutdown ───────────────────────────────
  test('Test 3: ephemeral consumer is removed from stream after shutdown', async () => {
    // Shutdown was already called in afterAll — but we need to call it before afterAll
    // and check the consumer list. Let's create a separate subscriber for this test.
    const nc3 = await connect(container.getConnectionOptions());
    const ee = new EventEmitter2();
    const emitter3 = new LeaderboardUpdatesInProcessAdapter(ee);
    const readiness3 = new ReadinessService();
    const subscriber3 = new JetStreamSubscriber(nc3, emitter3, readiness3);

    await subscriber3.onApplicationBootstrap();
    expect(readiness3.jetstreamReady).toBe(true);

    const jsmBefore = await nc3.jetstreamManager();
    const beforeConsumers: string[] = [];
    for await (const info of jsmBefore.consumers.list('SCOREBOARD')) {
      beforeConsumers.push(info.name);
    }
    expect(beforeConsumers.length).toBeGreaterThan(0);

    await subscriber3.onApplicationShutdown();
    expect(readiness3.jetstreamReady).toBe(false);

    // After shutdown, the consumer created by subscriber3 should be gone
    // (Note: consumer.delete() is called in onApplicationShutdown)
    // Verify by fetching the consumer list — it may still have consumers from
    // the main subscriber, but subscriber3's consumer should not appear.
    // We track the consumer name to verify deletion.
    const jsmAfter = await nc3.jetstreamManager();
    const afterConsumers: string[] = [];
    for await (const info of jsmAfter.consumers.list('SCOREBOARD')) {
      afterConsumers.push(info.name);
    }

    // Check the count decreased (subscriber3's consumer was deleted)
    // beforeConsumers includes subscriber3's + main subscriber's consumers
    // afterConsumers should have one fewer (subscriber3's deleted)
    expect(afterConsumers.length).toBeLessThan(beforeConsumers.length);

    await nc3.drain();
  });
});
