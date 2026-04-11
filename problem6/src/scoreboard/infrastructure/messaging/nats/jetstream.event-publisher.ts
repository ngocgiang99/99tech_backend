import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import { JSONCodec } from 'nats';
import type { NatsConnection } from 'nats';

import { DomainEvent, DomainEventPublisher } from '../../../domain';

import { JetStreamPublishError } from './jetstream-publish.error';

@Injectable()
export class JetStreamEventPublisher
  implements DomainEventPublisher, OnApplicationShutdown
{
  private readonly logger = new Logger(JetStreamEventPublisher.name);
  private readonly codec = JSONCodec<Record<string, unknown>>();
  private readonly js;
  private drained = false;

  constructor(@Inject('Nats') private readonly nats: NatsConnection) {
    this.js = this.nats.jetstream();
  }

  async publish(
    event: DomainEvent,
    { msgId }: { msgId: string },
  ): Promise<void> {
    try {
      await this.js.publish(event.subject, this.codec.encode(event.payload), {
        msgID: msgId,
      });
    } catch (err) {
      this.logger.error(
        `Failed to publish event ${event.subject} msgId=${msgId}: ${String(err)}`,
      );
      throw new JetStreamPublishError(
        `Failed to publish event ${event.subject}`,
        err,
      );
    }
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    if (this.drained) {
      return;
    }
    this.drained = true;
    try {
      await this.nats.drain();
      this.logger.log({ signal }, 'jetstream publisher drained');
    } catch (e) {
      // drain() fails if connection is already closing/draining (e.g. the
      // NatsClient wrapper already drained). That's fine — it's the same
      // desired terminal state.
      this.logger.debug(
        { err: e, signal },
        'jetstream publisher drain no-op (already draining)',
      );
    }
  }
}
