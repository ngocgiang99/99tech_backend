import { JetStreamPublishError } from '../../../../../../src/scoreboard/infrastructure/messaging/nats/jetstream-publish.error';
import { JetStreamEventPublisher } from '../../../../../../src/scoreboard/infrastructure/messaging/nats/jetstream.event-publisher';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJsMock(publishImpl: jest.Mock) {
  return {
    publish: publishImpl,
  };
}

function makeNatsConnection(jsMock: ReturnType<typeof makeJsMock>) {
  return {
    jetstream: jest.fn().mockReturnValue(jsMock),
  };
}

function makePubAck(duplicate = false) {
  return { duplicate, seq: 1, stream: 'SCOREBOARD', domain: '' };
}

const TEST_EVENT = {
  subject: 'scoreboard.score.credited',
  payload: { userId: 'user-1', delta: 100 },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JetStreamEventPublisher', () => {
  describe('happy path', () => {
    it('publishes the event with the correct subject, encoded payload, and msgID', async () => {
      const publishMock = jest.fn().mockResolvedValue(makePubAck());
      const js = makeJsMock(publishMock);
      const nc = makeNatsConnection(js);

      const publisher = new JetStreamEventPublisher(nc as never);

      await publisher.publish(TEST_EVENT, { msgId: 'msg-001' });

      expect(publishMock).toHaveBeenCalledTimes(1);
      const [subject, encodedPayload, options] = publishMock.mock.calls[0] as [
        string,
        Uint8Array,
        { msgID: string },
      ];

      expect(subject).toBe('scoreboard.score.credited');
      expect(options.msgID).toBe('msg-001');

      // The encoded payload should be valid JSON containing the original payload
      const decoded = JSON.parse(Buffer.from(encodedPayload).toString('utf8')) as Record<string, unknown>;
      expect(decoded).toEqual({ userId: 'user-1', delta: 100 });
    });
  });

  describe('dedup path', () => {
    it('resolves successfully when the server returns a PubAck with duplicate=true', async () => {
      const publishMock = jest.fn().mockResolvedValue(makePubAck(true));
      const js = makeJsMock(publishMock);
      const nc = makeNatsConnection(js);

      const publisher = new JetStreamEventPublisher(nc as never);

      // First publish
      await publisher.publish(TEST_EVENT, { msgId: 'msg-dup' });
      // Second publish with same msgId — still resolves (server returns duplicate=true)
      await publisher.publish(TEST_EVENT, { msgId: 'msg-dup' });

      expect(publishMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('error path', () => {
    it('throws JetStreamPublishError when js.publish rejects', async () => {
      const originalError = new Error('NATS server unavailable');
      const publishMock = jest.fn().mockRejectedValue(originalError);
      const js = makeJsMock(publishMock);
      const nc = makeNatsConnection(js);

      const publisher = new JetStreamEventPublisher(nc as never);

      await expect(
        publisher.publish(TEST_EVENT, { msgId: 'msg-err' }),
      ).rejects.toThrow(JetStreamPublishError);
    });

    it('preserves the original error as cause in JetStreamPublishError', async () => {
      const originalError = new Error('JetStream connection lost');
      const publishMock = jest.fn().mockRejectedValue(originalError);
      const js = makeJsMock(publishMock);
      const nc = makeNatsConnection(js);

      const publisher = new JetStreamEventPublisher(nc as never);

      let caughtError: JetStreamPublishError | undefined;
      try {
        await publisher.publish(TEST_EVENT, { msgId: 'msg-cause' });
      } catch (err) {
        caughtError = err as JetStreamPublishError;
      }

      expect(caughtError).toBeInstanceOf(JetStreamPublishError);
      expect(caughtError?.cause).toBe(originalError);
    });
  });
});
