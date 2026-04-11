import { Inject, Injectable } from '@nestjs/common';

import type { UserScoreRepository } from '../../domain/ports/user-score.repository';
import { UserScore } from '../../domain/user-score.aggregate';

import { IncrementScoreCommand } from './increment-score.command';

export const USER_SCORE_REPOSITORY = 'UserScoreRepository';

export interface IncrementScoreResult {
  userId: string;
  newScore: number;
  rank: number | null;
  topChanged: boolean | null;
}

@Injectable()
export class IncrementScoreHandler {
  constructor(
    @Inject(USER_SCORE_REPOSITORY)
    private readonly repo: UserScoreRepository,
  ) {}

  async execute(cmd: IncrementScoreCommand): Promise<IncrementScoreResult> {
    const aggregate =
      (await this.repo.findByUserId(cmd.userId)) ?? UserScore.empty(cmd.userId);

    aggregate.credit(cmd.actionId, cmd.delta, cmd.occurredAt);

    const events = aggregate.pullEvents();
    await this.repo.credit(aggregate, events[0]);

    return {
      userId: cmd.userId.value,
      newScore: aggregate.totalScore,
      rank: null,
      topChanged: null,
    };
  }
}
