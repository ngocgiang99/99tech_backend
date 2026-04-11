import { InvalidArgumentError } from './errors/invalid-argument.error';
import { ScoreCredited } from './events/score-credited.event';
import { ActionId } from './value-objects/action-id';
import { ScoreDelta } from './value-objects/score-delta';
import { UserId } from './value-objects/user-id';

interface UserScoreSnapshot {
  userId: UserId;
  totalScore: number;
  lastActionId: string | null;
  updatedAt: Date;
}

export class UserScore {
  private _events: ScoreCredited[] = [];

  private constructor(
    private readonly _userId: UserId,
    private _totalScore: number,
    private _lastActionId: string | null,
    private _updatedAt: Date,
  ) {
    if (!Number.isInteger(_totalScore) || _totalScore < 0) {
      throw new InvalidArgumentError(
        `UserScore totalScore must be a non-negative integer: received ${_totalScore}`,
      );
    }
  }

  static empty(userId: UserId): UserScore {
    return new UserScore(userId, 0, null, new Date(0));
  }

  static rehydrate(snapshot: UserScoreSnapshot): UserScore {
    return new UserScore(
      snapshot.userId,
      snapshot.totalScore,
      snapshot.lastActionId,
      snapshot.updatedAt,
    );
  }

  credit(actionId: ActionId, delta: ScoreDelta, occurredAt: Date): void {
    const newTotal = this._totalScore + delta.value;
    if (newTotal > Number.MAX_SAFE_INTEGER) {
      throw new InvalidArgumentError(
        `Credit would overflow MAX_SAFE_INTEGER: current=${this._totalScore} delta=${delta.value}`,
      );
    }
    this._totalScore = newTotal;
    this._lastActionId = actionId.value;
    this._updatedAt = occurredAt;
    this._events.push(
      new ScoreCredited({
        userId: this._userId.value,
        actionId: actionId.value,
        delta: delta.value,
        newTotal,
        occurredAt,
      }),
    );
  }

  pullEvents(): readonly ScoreCredited[] {
    const drained = this._events;
    this._events = [];
    return drained;
  }

  get userId(): UserId {
    return this._userId;
  }

  get totalScore(): number {
    return this._totalScore;
  }

  get lastActionId(): string | null {
    return this._lastActionId;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }
}
