import { IdempotencyViolationError } from '../../../../src/scoreboard/domain/errors/idempotency-violation.error';
import { ScoreCredited } from '../../../../src/scoreboard/domain/events/score-credited.event';
import type { UserScoreRepository } from '../../../../src/scoreboard/domain/ports/user-score.repository';
import { UserScore } from '../../../../src/scoreboard/domain/user-score.aggregate';
import { UserId } from '../../../../src/scoreboard/domain/value-objects/user-id';

export class FakeUserScoreRepository implements UserScoreRepository {
  private readonly users = new Map<string, UserScore>();
  private readonly seenActionIds = new Set<string>();

  async findByUserId(userId: UserId): Promise<UserScore | null> {
    return this.users.get(userId.value) ?? null;
  }

  async credit(aggregate: UserScore, event: ScoreCredited): Promise<void> {
    if (this.seenActionIds.has(event.actionId)) {
      throw new IdempotencyViolationError(event.actionId);
    }
    this.seenActionIds.add(event.actionId);
    this.users.set(aggregate.userId.value, aggregate);
  }
}
