/**
 * Integration test: JetStreamEventPublisher
 *
 * Uses @testcontainers/nats to spin up a real NATS server with JetStream enabled.
 *
 * Verifies:
 *   1. Happy publish: message is delivered to a pull consumer
 *   2. Dedup: same msgId published twice → only one message stored in stream
 *   3. Error path: publish on a drained connection throws JetStreamPublishError
 */

import { NatsContainer, StartedNatsContainer } from '@testcontainers/nats';
import {
  AckPolicy,
  connect,
  DeliverPolicy,
  JSONCodec,
  RetentionPolicy,
  type NatsConnection,
} from 'nats';

import { JetStreamEventPublisher } from '../../../src/scoreboard/infrastructure/messaging/nats/jetstream.event-publisher';
import { JetStreamPublishError } from '../../../src/scoreboard/infrastructure/messaging/nats/jetstream-publish.error';

jest.setTimeout(120_000);

const codec = JSONCodec<Record<string, unknown>>();

async function bootstrapStream(nc: NatsConnection): Promise<void> {
  const jsm = await nc.jetstreamManager();
  await jsm.streams.add({
    name: 'SCOREBOARD',
    subjects: ['scoreboard.>'],
    retention: RetentionPolicy.Limits,
    max_msgs: 10_000,
    duplicate_window: 120_000_000_000, // 120 seconds in nanoseconds
    num_replicas: 1,
  });
}


describe('JetStreamEventPublisher integration', () => {
  let container: StartedNatsContainer;
  let nc: NatsConnection;
  let publisher: JetStreamEventPublisher;

  beforeAll(async () => {
    container = await new NatsContainer('nats:2.10')
      .withJetStream()
      .start();

    nc = await connect(container.getConnectionOptions());
    await bootstrapStream(nc);
    publisher = new JetStreamEventPublisher(nc);
  });

  afterAll(async () => {
    await nc.drain();
    await container.stop();
  });

  // ─── Test 1: Happy publish ────────────────────────────────────────────────
  test('Test 1: publishes a message — test consumer receives correct payload', async () => {
    // Set up a pull consumer BEFORE publishing so we can pull DeliverAll messages
    const jsm = await nc.jetstreamManager();
    const consumerName = `happy-${Date.now()}`;
    await jsm.consumers.add('SCOREBOARD', {
      durable_name: consumerName,
      filter_subject: 'scoreboard.score.credited',
      deliver_policy: DeliverPolicy.New,
      ack_policy: AckPolicy.Explicit,
    });

    const js = nc.jetstream();
    const consumer = await js.consumers.get('SCOREBOARD', consumerName);
    const messages = await consumer.consume({ max_messages: 1 });

    // Publish AFTER consumer is ready
    await publisher.publish(
      { subject: 'scoreboard.score.credited', payload: { userId: 'u1', delta: 10 } },
      { msgId: 'happy-msg-1' },
    );

    // Collect the message
    const received: Record<string, unknown>[] = [];
    for await (const msg of messages) {
      received.push(codec.decode(msg.data));
      msg.ack();
      messages.stop();
      break;
    }

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(expect.objectContaining({ userId: 'u1', delta: 10 }));

    await jsm.consumers.delete('SCOREBOARD', consumerName);
  });

  // ─── Test 2: Dedup — same msgId → only one delivery ──────────────────────
  test('Test 2: dedup — publishing same msgId twice delivers exactly one message', async () => {
    const jsm = await nc.jetstreamManager();
    const consumerName = `dedup-${Date.now()}`;
    await jsm.consumers.add('SCOREBOARD', {
      durable_name: consumerName,
      filter_subject: 'scoreboard.score.credited',
      deliver_policy: DeliverPolicy.New,
      ack_policy: AckPolicy.Explicit,
    });

    const js = nc.jetstream();
    const consumer = await js.consumers.get('SCOREBOARD', consumerName);

    const dedupId = `dedup-id-${Date.now()}`;
    // Publish twice with same msgId
    await publisher.publish(
      { subject: 'scoreboard.score.credited', payload: { test: 'dedup', seq: 1 } },
      { msgId: dedupId },
    );
    await publisher.publish(
      { subject: 'scoreboard.score.credited', payload: { test: 'dedup', seq: 2 } },
      { msgId: dedupId }, // same msgId — JetStream dedup should drop this
    );

    // Wait briefly for dedup window processing
    await new Promise((r) => setTimeout(r, 500));

    // Fetch pending messages directly from the stream — use fetch() with a short timeout
    // fetch() returns ConsumerMessages (async iterable); await it to start the pull
    const fetched = await consumer.fetch({ max_messages: 10, expires: 2_000 });
    const received: Record<string, unknown>[] = [];
    for await (const msg of fetched) {
      received.push(codec.decode(msg.data));
      msg.ack();
    }

    // JetStream dedup: second message with same msgId is not stored
    expect(received.length).toBe(1);
    expect(received[0]).toEqual(expect.objectContaining({ test: 'dedup', seq: 1 }));

    await jsm.consumers.delete('SCOREBOARD', consumerName);
  });

  // ─── Test 3: Error path ───────────────────────────────────────────────────
  test('Test 3: publish on a drained connection throws JetStreamPublishError', async () => {
    const brokenNc = await connect(container.getConnectionOptions());
    const brokenPublisher = new JetStreamEventPublisher(brokenNc);

    // Drain the connection — any subsequent publish attempt will fail
    await brokenNc.drain();

    await expect(
      brokenPublisher.publish(
        { subject: 'scoreboard.score.credited', payload: { x: 1 } },
        { msgId: 'error-test-1' },
      ),
    ).rejects.toThrow(JetStreamPublishError);
  });
});
