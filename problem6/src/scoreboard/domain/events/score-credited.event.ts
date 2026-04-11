export class ScoreCredited {
  readonly userId: string;
  readonly actionId: string;
  readonly delta: number;
  readonly newTotal: number;
  readonly occurredAt: Date;

  constructor(params: {
    userId: string;
    actionId: string;
    delta: number;
    newTotal: number;
    occurredAt: Date;
  }) {
    this.userId = params.userId;
    this.actionId = params.actionId;
    this.delta = params.delta;
    this.newTotal = params.newTotal;
    this.occurredAt = params.occurredAt;
  }
}
