import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Counter } from 'prom-client';

import { METRIC_SCORE_INCREMENT_TOTAL } from '../../../shared/metrics';
import type { LeaderboardCache } from '../../domain/ports/leaderboard-cache';
import type {
  OutboxRow,
  UserScoreRepository,
} from '../../domain/ports/user-score.repository';
import { Score } from '../../domain/value-objects/score';
import { UserScore } from '../../domain/user-score.aggregate';

import { IncrementScoreCommand } from './increment-score.command';

export const USER_SCORE_REPOSITORY = 'UserScoreRepository';
export const LEADERBOARD_CACHE = 'LeaderboardCache';

export interface IncrementScoreResult {
  userId: string;
  newScore: number;
  rank: number | null;
  topChanged: boolean | null;
}

@Injectable()
export class IncrementScoreHandler {
  private readonly logger = new Logger(IncrementScoreHandler.name);

  constructor(
    @Inject(USER_SCORE_REPOSITORY)
    private readonly repo: UserScoreRepository,
    @Inject(METRIC_SCORE_INCREMENT_TOTAL)
    private readonly scoreIncrementTotal: Counter<string>,
    @Inject(LEADERBOARD_CACHE)
    private readonly cache: LeaderboardCache,
  ) {}

  async execute(cmd: IncrementScoreCommand): Promise<IncrementScoreResult> {
    const aggregate =
      (await this.repo.findByUserId(cmd.userId)) ?? UserScore.empty(cmd.userId);

    aggregate.credit(cmd.actionId, cmd.delta, cmd.occurredAt);

    const events = aggregate.pullEvents();

    const outboxRows: OutboxRow[] = [
      {
        aggregateId: cmd.userId.value,
        eventType: 'scoreboard.score.credited',
        payload: {
          userId: cmd.userId.value,
          actionId: cmd.actionId.value,
          delta: cmd.delta.value,
          newTotal: aggregate.totalScore,
          occurredAt: cmd.occurredAt.toISOString(),
        },
      },
      {
        aggregateId: cmd.userId.value,
        eventType: 'scoreboard.leaderboard.updated',
        payload: {
          userId: cmd.userId.value,
          newTotal: aggregate.totalScore,
          occurredAt: cmd.occurredAt.toISOString(),
        },
      },
    ];

    await this.repo.credit(aggregate, events[0], outboxRows);

    this.scoreIncrementTotal.inc({ result: 'committed' });

    let rank: number | null = null;
    let topChanged: boolean | null = null;

    try {
      await this.cache.upsert(
        cmd.userId,
        Score.of(aggregate.totalScore),
        aggregate.updatedAt,
      );
      rank = await this.cache.getRank(cmd.userId);
      const top = await this.cache.getTop(10);
      topChanged = top.some((e) => e.userId === cmd.userId.value);
    } catch (err) {
      this.logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          userId: cmd.userId.value,
        },
        'leaderboard cache update failed, returning null rank/topChanged',
      );
      // rank and topChanged remain null
    }

    return {
      userId: cmd.userId.value,
      newScore: aggregate.totalScore,
      rank,
      topChanged,
    };
  }
}
