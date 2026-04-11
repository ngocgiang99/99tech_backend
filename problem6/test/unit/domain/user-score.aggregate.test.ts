import { InvalidArgumentError } from '../../../src/scoreboard/domain/errors/invalid-argument.error';
import { UserScore } from '../../../src/scoreboard/domain/user-score.aggregate';
import { ActionId } from '../../../src/scoreboard/domain/value-objects/action-id';
import { ScoreDelta } from '../../../src/scoreboard/domain/value-objects/score-delta';
import { UserId } from '../../../src/scoreboard/domain/value-objects/user-id';

const USER = UserId.of('550e8400-e29b-41d4-a716-446655440000');
const ACTION_A = ActionId.of('11111111-1111-1111-1111-111111111111');
const ACTION_B = ActionId.of('22222222-2222-2222-2222-222222222222');

describe('UserScore.empty', () => {
  it('returns a fresh aggregate with zero total and no last action', () => {
    const agg = UserScore.empty(USER);
    expect(agg.userId).toBe(USER);
    expect(agg.totalScore).toBe(0);
    expect(agg.lastActionId).toBeNull();
    expect(agg.updatedAt).toEqual(new Date(0));
    expect(agg.pullEvents()).toHaveLength(0);
  });
});

describe('UserScore.rehydrate', () => {
  it('reconstructs from a valid snapshot', () => {
    const snapshot = {
      userId: USER,
      totalScore: 100,
      lastActionId: ACTION_A.value,
      updatedAt: new Date('2025-01-01T00:00:00Z'),
    };
    const agg = UserScore.rehydrate(snapshot);
    expect(agg.totalScore).toBe(100);
    expect(agg.lastActionId).toBe(ACTION_A.value);
    expect(agg.updatedAt).toEqual(new Date('2025-01-01T00:00:00Z'));
  });

  it('throws on negative totalScore', () => {
    expect(() =>
      UserScore.rehydrate({
        userId: USER,
        totalScore: -5,
        lastActionId: null,
        updatedAt: new Date(),
      }),
    ).toThrow(InvalidArgumentError);
  });

  it('throws on non-integer totalScore', () => {
    expect(() =>
      UserScore.rehydrate({
        userId: USER,
        totalScore: 1.5,
        lastActionId: null,
        updatedAt: new Date(),
      }),
    ).toThrow(InvalidArgumentError);
  });
});

describe('UserScore.credit', () => {
  it('increments total and emits exactly one event with correct shape', () => {
    const agg = UserScore.empty(USER);
    const at = new Date('2025-06-01T12:00:00Z');
    agg.credit(ACTION_A, ScoreDelta.of(5), at);

    expect(agg.totalScore).toBe(5);
    expect(agg.lastActionId).toBe(ACTION_A.value);
    expect(agg.updatedAt).toEqual(at);

    const events = agg.pullEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      userId: USER.value,
      actionId: ACTION_A.value,
      delta: 5,
      newTotal: 5,
      occurredAt: at,
    });
  });

  it('accumulates credits and events across multiple calls', () => {
    const agg = UserScore.empty(USER);
    const t1 = new Date('2025-06-01T12:00:00Z');
    const t2 = new Date('2025-06-01T12:00:01Z');
    agg.credit(ACTION_A, ScoreDelta.of(5), t1);
    agg.credit(ACTION_B, ScoreDelta.of(3), t2);

    expect(agg.totalScore).toBe(8);
    expect(agg.lastActionId).toBe(ACTION_B.value);
    expect(agg.updatedAt).toEqual(t2);

    const events = agg.pullEvents();
    expect(events).toHaveLength(2);
    expect(events[0].actionId).toBe(ACTION_A.value);
    expect(events[0].newTotal).toBe(5);
    expect(events[1].actionId).toBe(ACTION_B.value);
    expect(events[1].newTotal).toBe(8);
  });

  it('credit on rehydrated aggregate starts from existing total', () => {
    const agg = UserScore.rehydrate({
      userId: USER,
      totalScore: 100,
      lastActionId: null,
      updatedAt: new Date(0),
    });
    agg.credit(ACTION_A, ScoreDelta.of(25), new Date());
    expect(agg.totalScore).toBe(125);
  });

  it('throws when credit would overflow MAX_SAFE_INTEGER', () => {
    const agg = UserScore.rehydrate({
      userId: USER,
      totalScore: Number.MAX_SAFE_INTEGER,
      lastActionId: null,
      updatedAt: new Date(0),
    });
    expect(() => agg.credit(ACTION_A, ScoreDelta.of(1), new Date())).toThrow(
      InvalidArgumentError,
    );
  });
});

describe('UserScore.pullEvents', () => {
  it('drains the collection on call', () => {
    const agg = UserScore.empty(USER);
    agg.credit(ACTION_A, ScoreDelta.of(5), new Date());

    const first = agg.pullEvents();
    expect(first).toHaveLength(1);

    const second = agg.pullEvents();
    expect(second).toHaveLength(0);
  });
});
