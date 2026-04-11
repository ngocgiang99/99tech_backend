import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';

import {
  LeaderboardCache,
  LeaderboardEntry,
} from '../../../domain/ports/leaderboard-cache';
import { Score } from '../../../domain/value-objects/score';
import { UserId } from '../../../domain/value-objects/user-id';

import { decodeScore, encodeScore } from './leaderboard-types';

const LEADERBOARD_KEY = 'leaderboard:global';

@Injectable()
export class RedisLeaderboardCache implements LeaderboardCache {
  constructor(@Inject('Redis') private readonly redis: Redis) {}

  async upsert(userId: UserId, score: Score, updatedAt: Date): Promise<void> {
    const updatedAtSeconds = Math.floor(updatedAt.getTime() / 1000);
    const encoded = encodeScore(score.value, updatedAtSeconds);
    await this.redis.zadd(LEADERBOARD_KEY, encoded, userId.value);
  }

  async getTop(n: number): Promise<LeaderboardEntry[]> {
    const raw = await this.redis.zrevrange(
      LEADERBOARD_KEY,
      0,
      n - 1,
      'WITHSCORES',
    );
    // raw is [userId, encodedStr, userId, encodedStr, ...]
    const entries: LeaderboardEntry[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      const userId = raw[i];
      const encoded = parseFloat(raw[i + 1]);
      const { score, updatedAtSeconds } = decodeScore(encoded);
      entries.push({
        rank: entries.length + 1,
        userId,
        score,
        updatedAt: new Date(updatedAtSeconds * 1000),
      });
    }
    return entries;
  }

  async getRank(userId: UserId): Promise<number | null> {
    const result = await this.redis.zrevrank(LEADERBOARD_KEY, userId.value);
    if (result === null) {
      return null;
    }
    return result + 1;
  }
}
