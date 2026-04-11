import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { DATABASE, type Database } from '../../../../database';
import { ConfigService } from '../../../../config';
import { encodeScore } from './leaderboard-types';

const REBUILD_LOCK_KEY = 'leaderboard:rebuild:lock';
const LEADERBOARD_KEY = 'leaderboard:global';
const BATCH_SIZE = 1000;
const LOCK_TTL_SECONDS = 300;

@Injectable()
export class LeaderboardRebuilder {
  private readonly logger = new Logger(LeaderboardRebuilder.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject('Redis') private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {}

  async rebuild(): Promise<{ usersProcessed: number; elapsedMs: number }> {
    const instanceId = randomUUID();
    const lockAcquired = await this.redis.set(
      REBUILD_LOCK_KEY,
      instanceId,
      'EX',
      LOCK_TTL_SECONDS,
      'NX',
    );

    if (lockAcquired === null) {
      this.logger.log('another instance is rebuilding, skipping');
      return { usersProcessed: 0, elapsedMs: 0 };
    }

    try {
      const startTs = Date.now();
      const topN = this.config.get('LEADERBOARD_REBUILD_TOP_N');

      const rows = await this.db
        .selectFrom('user_scores')
        .select(['user_id', 'total_score', 'updated_at'])
        .orderBy('total_score', 'desc')
        .orderBy('updated_at', 'asc')
        .limit(topN)
        .execute();

      const total = rows.length;
      let processed = 0;

      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const pipeline = this.redis.multi();

        for (const row of batch) {
          const updatedAtSeconds = Math.floor(
            new Date(row.updated_at).getTime() / 1000,
          );
          const encoded = encodeScore(
            Number(row.total_score),
            updatedAtSeconds,
          );
          pipeline.zadd(LEADERBOARD_KEY, encoded, row.user_id);
        }

        await pipeline.exec();
        processed += batch.length;

        this.logger.log(
          {
            processed,
            total,
            elapsedMs: Date.now() - startTs,
          },
          'leaderboard rebuild batch',
        );
      }

      return { usersProcessed: total, elapsedMs: Date.now() - startTs };
    } finally {
      // Only release the lock if WE acquired it
      if (lockAcquired !== null) {
        await this.redis.del(REBUILD_LOCK_KEY);
      }
    }
  }
}
