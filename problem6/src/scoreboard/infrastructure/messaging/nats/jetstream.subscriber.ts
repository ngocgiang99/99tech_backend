import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { AckPolicy, DeliverPolicy, JSONCodec } from 'nats';
import type { Consumer, ConsumerMessages, NatsConnection } from 'nats';

import { ReadinessService } from '../../../../shared/readiness/readiness.service';

import {
  LeaderboardUpdateEvent,
  LeaderboardUpdatesEmitter,
} from './leaderboard-updates.emitter';

@Injectable()
export class JetStreamSubscriber
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(JetStreamSubscriber.name);
  private readonly codec = JSONCodec<LeaderboardUpdateEvent>();

  private consumer: Consumer | null = null;
  private messages: ConsumerMessages | null = null;
  private abortController: AbortController | null = null;
  private consumerName: string | null = null;
  private consumeLoopPromise: Promise<void> | null = null;

  constructor(
    @Inject('Nats') private readonly nats: NatsConnection,
    private readonly emitter: LeaderboardUpdatesEmitter,
    private readonly readiness: ReadinessService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const jsm = await this.nats.jetstreamManager();
      const consumerInfo = await jsm.consumers.add('SCOREBOARD', {
        filter_subject: 'scoreboard.leaderboard.updated',
        deliver_policy: DeliverPolicy.New,
        ack_policy: AckPolicy.Explicit,
        ack_wait: 5_000_000_000, // 5 seconds in nanoseconds
        inactive_threshold: 30_000_000_000, // 30 seconds in nanoseconds
      });

      this.consumerName = consumerInfo.name;

      const js = this.nats.jetstream();
      this.consumer = await js.consumers.get('SCOREBOARD', this.consumerName);

      this.abortController = new AbortController();
      this.consumeLoopPromise = this.runConsumeLoop();

      this.readiness.jetstreamReady = true;
      this.logger.log(
        { consumerName: this.consumerName },
        'jetstream ephemeral consumer created',
      );
    } catch (e) {
      this.logger.error({ err: e }, 'failed to bootstrap jetstream consumer');
    }
  }

  private async runConsumeLoop(): Promise<void> {
    if (!this.consumer) {
      return;
    }

    try {
      this.messages = await this.consumer.consume();

      for await (const msg of this.messages) {
        if (this.abortController?.signal.aborted) {
          this.messages.stop();
          break;
        }

        try {
          const event = this.codec.decode(msg.data);
          this.emitter.emit(event);
          msg.ack();
        } catch (e) {
          this.logger.error(
            { err: e, subject: msg.subject },
            'failed to process leaderboard message',
          );
          msg.nak();
        }
      }
    } catch (e) {
      if (!this.abortController?.signal.aborted) {
        this.logger.error(
          { err: e },
          'jetstream consumer loop died unexpectedly',
        );
        this.readiness.jetstreamReady = false;
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.logger.log('jetstream subscriber shutting down');
    this.abortController?.abort();
    this.messages?.stop();

    if (this.consumeLoopPromise) {
      await Promise.race([
        this.consumeLoopPromise,
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }

    this.readiness.jetstreamReady = false;

    // Politely delete the ephemeral consumer (auto-cleans via inactive_threshold anyway)
    if (this.consumer) {
      try {
        await this.consumer.delete();
        this.logger.log(
          { consumerName: this.consumerName },
          'ephemeral consumer deleted',
        );
      } catch (e) {
        this.logger.debug(
          { err: e },
          'consumer delete failed (probably already cleaned up)',
        );
      }
    }
  }
}
