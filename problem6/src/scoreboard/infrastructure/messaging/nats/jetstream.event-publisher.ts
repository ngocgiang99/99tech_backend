import { Inject, Injectable, Logger } from '@nestjs/common';
import { JSONCodec } from 'nats';
import type { NatsConnection } from 'nats';

import { DomainEvent, DomainEventPublisher } from '../../../domain';

import { JetStreamPublishError } from './jetstream-publish.error';

@Injectable()
export class JetStreamEventPublisher implements DomainEventPublisher {
  private readonly logger = new Logger(JetStreamEventPublisher.name);
  private readonly codec = JSONCodec<Record<string, unknown>>();
  private readonly js;

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
}
