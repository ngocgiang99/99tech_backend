import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
  Provider,
} from '@nestjs/common';
import type { NatsConnection } from 'nats';

import { ConfigModule, ConfigService } from '../../../../config';
import { DOMAIN_EVENT_PUBLISHER } from '../../../domain';

import { JetStreamEventPublisher } from './jetstream.event-publisher';
import { JetStreamSubscriber } from './jetstream.subscriber';
import { LeaderboardUpdatesEmitter } from './leaderboard-updates.emitter';
import { buildNatsClient } from './nats.client';
import { StreamBootstrap } from './stream-bootstrap';

export const NATS_CONNECTION = 'Nats';

const natsConnectionProvider: Provider = {
  provide: NATS_CONNECTION,
  useFactory: (config: ConfigService): Promise<NatsConnection> =>
    buildNatsClient(config),
  inject: [ConfigService],
};

const domainEventPublisherProvider: Provider = {
  provide: DOMAIN_EVENT_PUBLISHER,
  useClass: JetStreamEventPublisher,
};

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    natsConnectionProvider,
    StreamBootstrap,
    JetStreamEventPublisher,
    domainEventPublisherProvider,
    LeaderboardUpdatesEmitter,
    JetStreamSubscriber,
  ],
  exports: [
    NATS_CONNECTION,
    StreamBootstrap,
    JetStreamEventPublisher,
    DOMAIN_EVENT_PUBLISHER,
    LeaderboardUpdatesEmitter,
    JetStreamSubscriber,
  ],
})
export class NatsModule implements OnApplicationShutdown {
  private readonly logger = new Logger(NatsModule.name);
  private closed = false;

  constructor(@Inject(NATS_CONNECTION) private readonly nc: NatsConnection) {}

  // drain() is idempotent and safe to call even if the JetStreamEventPublisher
  // has already drained — the NATS client marks itself draining/closed on the
  // first call, so subsequent drain()s no-op (or throw, which we swallow).
  async onApplicationShutdown(signal?: string): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await this.nc.drain();
    } catch (e) {
      this.logger.debug(
        { err: e, signal },
        'nats drain no-op (already draining)',
      );
    }
    try {
      await this.nc.close();
    } catch (e) {
      this.logger.debug(
        { err: e, signal },
        'nats close no-op (already closed)',
      );
    }
    this.logger.log({ signal }, 'nats client closed');
  }
}
