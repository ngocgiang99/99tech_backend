import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import type { Redis } from 'ioredis';

import { ReadinessService } from '../../../../shared/readiness';

import { LeaderboardRebuilder } from './leaderboard-rebuilder';

const LEADERBOARD_KEY = 'leaderboard:global';

@Injectable()
export class LeaderboardRebuildBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(LeaderboardRebuildBootstrap.name);

  constructor(
    private readonly rebuilder: LeaderboardRebuilder,
    @Inject('Redis') private readonly redis: Redis,
    private readonly readiness: ReadinessService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const card = await this.redis.zcard(LEADERBOARD_KEY);

      if (card === 0) {
        this.logger.log('leaderboard cache empty, starting rebuild');
        const result = await this.rebuilder.rebuild();
        this.logger.log({ result }, 'leaderboard rebuild completed');
      } else {
        this.logger.log({ card }, 'cache already populated, skipping rebuild');
      }

      this.readiness.leaderboardReady = true;
    } catch (err) {
      this.logger.error({ err }, 'leaderboard rebuild failed');
      this.readiness.leaderboardReady = false;
      // Do NOT rethrow — boot continues, operator can manually trigger rebuild
    }
  }
}
