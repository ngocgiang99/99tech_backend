import {
  Global,
  Inject,
  Module,
  OnModuleDestroy,
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
export class NatsModule implements OnModuleDestroy {
  constructor(@Inject(NATS_CONNECTION) private readonly nc: NatsConnection) {}

  async onModuleDestroy(): Promise<void> {
    await this.nc.drain();
  }
}
