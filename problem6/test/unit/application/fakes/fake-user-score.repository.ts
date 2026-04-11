import { IdempotencyViolationError } from '../../../../src/scoreboard/domain/errors/idempotency-violation.error';
import { ScoreCredited } from '../../../../src/scoreboard/domain/events/score-credited.event';
import type {
  OutboxRow,
  ScoreEventRecord,
  UserScoreRepository,
} from '../../../../src/scoreboard/domain/ports/user-score.repository';
import { UserScore } from '../../../../src/scoreboard/domain/user-score.aggregate';
import { ActionId } from '../../../../src/scoreboard/domain/value-objects/action-id';
import { UserId } from '../../../../src/scoreboard/domain/value-objects/user-id';

export class FakeUserScoreRepository implements UserScoreRepository {
  private readonly users = new Map<string, UserScore>();
  private readonly seenActionIds = new Set<string>();
  private readonly scoreEvents = new Map<string, ScoreEventRecord>();

  public readonly outboxRows: OutboxRow[] = [];

  async findByUserId(userId: UserId): Promise<UserScore | null> {
    return this.users.get(userId.value) ?? null;
  }

  async credit(
    aggregate: UserScore,
    event: ScoreCredited,
    outboxRows: OutboxRow[],
  ): Promise<void> {
    if (this.seenActionIds.has(event.actionId)) {
      throw new IdempotencyViolationError(event.actionId);
    }
    this.seenActionIds.add(event.actionId);
    this.users.set(aggregate.userId.value, aggregate);
    this.outboxRows.push(...outboxRows);
    // Record the event for idempotent-replay lookups; totalScoreAfter is the post-credit total.
    this.scoreEvents.set(event.actionId, {
      actionId: event.actionId,
      userId: event.userId,
      delta: event.delta,
      totalScoreAfter: aggregate.totalScore,
      occurredAt: event.occurredAt,
    });
  }

  async findScoreEventByActionId(
    actionId: ActionId,
  ): Promise<ScoreEventRecord | null> {
    return this.scoreEvents.get(actionId.value) ?? null;
  }
}
