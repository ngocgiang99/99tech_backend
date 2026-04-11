import { ScoreCredited } from '../events/score-credited.event';
import { UserScore } from '../user-score.aggregate';
import { ActionId } from '../value-objects/action-id';
import { UserId } from '../value-objects/user-id';

/**
 * Historical record of a settled score-credit event.
 * Used by the controller's idempotent-replay path to reconstruct
 * the original response DTO without re-running the handler.
 */
export interface ScoreEventRecord {
  actionId: string;
  userId: string;
  delta: number;
  /** The user's running total AFTER this credit settled (v1: reads current total — post-credit drift accepted for MVP). */
  totalScoreAfter: number;
  occurredAt: Date;
}

/**
 * Outbox row to be inserted atomically inside the credit() transaction.
 * The outbox publisher (step-06) will relay these rows to NATS/JetStream.
 */
export interface OutboxRow {
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface UserScoreRepository {
  findByUserId(userId: UserId): Promise<UserScore | null>;
  credit(
    aggregate: UserScore,
    event: ScoreCredited,
    outboxRow: OutboxRow,
  ): Promise<void>;
  findScoreEventByActionId(
    actionId: ActionId,
  ): Promise<ScoreEventRecord | null>;
}
