import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Counter } from 'prom-client';

import { METRIC_SCORE_INCREMENT_TOTAL } from '../../../shared/metrics';
import { IdempotencyViolationError } from '../../domain/errors/idempotency-violation.error';
import type { LeaderboardCache } from '../../domain/ports/leaderboard-cache';
import type {
  OutboxRow,
  UserScoreRepository,
} from '../../domain/ports/user-score.repository';
import { Score } from '../../domain/value-objects/score';
import { UserScore } from '../../domain/user-score.aggregate';
import { InternalError } from '../../shared/errors';

import { IncrementScoreCommand } from './increment-score.command';

export const USER_SCORE_REPOSITORY = 'UserScoreRepository';
export const LEADERBOARD_CACHE = 'LeaderboardCache';

export type IncrementScoreResult =
  | {
      kind: 'committed';
      userId: string;
      newScore: number;
      rank: number | null;
      topChanged: boolean | null;
    }
  | {
      kind: 'idempotent-replay';
      userId: string;
      newScore: number;
      rank: null;
      topChanged: null;
    };

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

    try {
      await this.repo.credit(aggregate, events[0], outboxRows);
    } catch (err) {
      if (err instanceof IdempotencyViolationError) {
        const prior = await this.repo.findScoreEventByActionId(cmd.actionId);
        if (!prior) {
          throw new InternalError(
            'Prior credit record not found for idempotent replay',
            { cause: err },
          );
        }
        this.scoreIncrementTotal.inc({ result: 'idempotent' });
        return {
          kind: 'idempotent-replay',
          userId: prior.userId,
          newScore: prior.totalScoreAfter,
          rank: null,
          topChanged: null,
        };
      }
      throw err;
    }

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
    }

    return {
      kind: 'committed',
      userId: cmd.userId.value,
      newScore: aggregate.totalScore,
      rank,
      topChanged,
    };
  }
}
