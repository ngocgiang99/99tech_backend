import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { NatsError, RetentionPolicy } from 'nats';
import type { JetStreamManager, NatsConnection } from 'nats';

import { ConfigService } from '../../../../config';

const STREAM_ALREADY_EXISTS_CODE = 10058;

@Injectable()
export class StreamBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(StreamBootstrap.name);

  constructor(
    @Inject('Nats') private readonly nc: NatsConnection,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const jsm = await this.nc.jetstreamManager();

    const streamConfig = {
      name: 'SCOREBOARD',
      subjects: ['scoreboard.>'],
      retention: RetentionPolicy.Limits,
      max_age: this.config.get('NATS_STREAM_MAX_AGE_SECONDS') * 1_000_000_000,
      max_msgs: this.config.get('NATS_STREAM_MAX_MSGS'),
      max_bytes: this.config.get('NATS_STREAM_MAX_BYTES'),
      duplicate_window:
        this.config.get('NATS_DEDUP_WINDOW_SECONDS') * 1_000_000_000,
      num_replicas: this.config.get('NATS_STREAM_REPLICAS'),
    };

    try {
      await jsm.streams.add(streamConfig);
      this.logger.log('SCOREBOARD stream created');
    } catch (err) {
      if (
        err instanceof NatsError &&
        err.isJetStreamError() &&
        err.jsError()?.code === STREAM_ALREADY_EXISTS_CODE
      ) {
        this.logger.log('stream already configured');
        await this.checkForDrift(jsm, streamConfig);
        return;
      }
      throw err;
    }
  }

  private async checkForDrift(
    jsm: JetStreamManager,
    desired: {
      max_age: number;
      max_msgs: number;
      max_bytes: number;
      duplicate_window: number;
      num_replicas: number;
    },
  ): Promise<void> {
    try {
      const info = await jsm.streams.info('SCOREBOARD');
      const existing = info.config;
      const drifted: string[] = [];

      if (existing.max_age !== desired.max_age) {
        drifted.push(
          `max_age (existing=${existing.max_age}, desired=${desired.max_age})`,
        );
      }
      if (existing.max_msgs !== desired.max_msgs) {
        drifted.push(
          `max_msgs (existing=${existing.max_msgs}, desired=${desired.max_msgs})`,
        );
      }
      if (existing.max_bytes !== desired.max_bytes) {
        drifted.push(
          `max_bytes (existing=${existing.max_bytes}, desired=${desired.max_bytes})`,
        );
      }
      if (existing.duplicate_window !== desired.duplicate_window) {
        drifted.push(
          `duplicate_window (existing=${existing.duplicate_window}, desired=${desired.duplicate_window})`,
        );
      }
      if (existing.num_replicas !== desired.num_replicas) {
        drifted.push(
          `num_replicas (existing=${existing.num_replicas}, desired=${desired.num_replicas})`,
        );
      }

      if (drifted.length > 0) {
        this.logger.warn(
          `SCOREBOARD stream config drifted — fields: ${drifted.join(', ')}. Manual update required.`,
        );
      }
    } catch (infoErr) {
      this.logger.warn(
        `Could not fetch SCOREBOARD stream info for drift check: ${String(infoErr)}`,
      );
    }
  }
}
