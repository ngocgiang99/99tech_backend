import { Inject, Injectable } from '@nestjs/common';

import {
  LEADERBOARD_CACHE_TOKEN,
  type LeaderboardCache,
} from '../../domain/ports/leaderboard-cache';
import type {
  TopEntry,
  UserScoreRepository,
} from '../../domain/ports/user-score.repository';
import { USER_SCORE_REPOSITORY } from '../commands';

export interface GetLeaderboardTopResult {
  source: 'hit' | 'miss';
  entries: TopEntry[];
}

@Injectable()
export class GetLeaderboardTopHandler {
  constructor(
    @Inject(LEADERBOARD_CACHE_TOKEN)
    private readonly cache: LeaderboardCache,
    @Inject(USER_SCORE_REPOSITORY)
    private readonly repo: UserScoreRepository,
  ) {}

  async execute(limit: number): Promise<GetLeaderboardTopResult> {
    try {
      const entries = await this.cache.getTop(limit);
      return { source: 'hit', entries };
    } catch {
      const entries = await this.repo.findTopN(limit);
      return { source: 'miss', entries };
    }
  }
}
