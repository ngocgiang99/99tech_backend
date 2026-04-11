import type { ActionId } from '../../domain/value-objects/action-id';
import type { ScoreDelta } from '../../domain/value-objects/score-delta';
import type { UserId } from '../../domain/value-objects/user-id';

export class IncrementScoreCommand {
  readonly userId: UserId;
  readonly actionId: ActionId;
  readonly delta: ScoreDelta;
  readonly occurredAt: Date;

  constructor(params: {
    userId: UserId;
    actionId: ActionId;
    delta: ScoreDelta;
    occurredAt: Date;
  }) {
    this.userId = params.userId;
    this.actionId = params.actionId;
    this.delta = params.delta;
    this.occurredAt = params.occurredAt;
  }
}
