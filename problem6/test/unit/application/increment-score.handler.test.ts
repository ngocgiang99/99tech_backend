import { IncrementScoreCommand } from '../../../src/scoreboard/application/commands/increment-score.command';
import { IncrementScoreHandler } from '../../../src/scoreboard/application/commands/increment-score.handler';
import { IdempotencyViolationError } from '../../../src/scoreboard/domain/errors/idempotency-violation.error';
import { InvalidArgumentError } from '../../../src/scoreboard/domain/errors/invalid-argument.error';
import { UserScore } from '../../../src/scoreboard/domain/user-score.aggregate';
import { ActionId } from '../../../src/scoreboard/domain/value-objects/action-id';
import { ScoreDelta } from '../../../src/scoreboard/domain/value-objects/score-delta';
import { UserId } from '../../../src/scoreboard/domain/value-objects/user-id';

import { FakeUserScoreRepository } from './fakes/fake-user-score.repository';

const USER = UserId.of('550e8400-e29b-41d4-a716-446655440000');
const ACTION_A = ActionId.of('11111111-1111-1111-1111-111111111111');
const ACTION_B = ActionId.of('22222222-2222-2222-2222-222222222222');

describe('IncrementScoreHandler.execute', () => {
  it('happy path with existing user returns the new total and null rank/topChanged', async () => {
    const repo = new FakeUserScoreRepository();
    // Seed existing user via direct rehydrate + credit to populate the fake
    const seeded = UserScore.rehydrate({
      userId: USER,
      totalScore: 100,
      lastActionId: null,
      updatedAt: new Date('2025-01-01T00:00:00Z'),
    });
    seeded.credit(
      ActionId.of('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
      ScoreDelta.of(1),
      new Date('2025-01-01T00:00:00Z'),
    );
    // Drain the priming event so we don't trigger idempotency on the real test
    const seedEvent = seeded.pullEvents()[0];
    await repo.credit(seeded, seedEvent);

    const handler = new IncrementScoreHandler(repo);
    const now = new Date('2025-06-01T12:00:00Z');
    const result = await handler.execute(
      new IncrementScoreCommand({
        userId: USER,
        actionId: ACTION_B,
        delta: ScoreDelta.of(10),
        occurredAt: now,
      }),
    );

    expect(result).toEqual({
      userId: USER.value,
      newScore: 111, // 100 + 1 seed + 10
      rank: null,
      topChanged: null,
    });
  });

  it('new user (no existing row) starts from UserScore.empty', async () => {
    const repo = new FakeUserScoreRepository();
    const handler = new IncrementScoreHandler(repo);
    const now = new Date('2025-06-01T12:00:00Z');

    const result = await handler.execute(
      new IncrementScoreCommand({
        userId: USER,
        actionId: ACTION_A,
        delta: ScoreDelta.of(7),
        occurredAt: now,
      }),
    );

    expect(result).toEqual({
      userId: USER.value,
      newScore: 7,
      rank: null,
      topChanged: null,
    });

    // Verify the fake stored the updated aggregate
    const stored = await repo.findByUserId(USER);
    expect(stored).not.toBeNull();
    expect(stored!.totalScore).toBe(7);
    expect(stored!.lastActionId).toBe(ACTION_A.value);
  });

  it('idempotent replay of the same actionId raises IdempotencyViolationError', async () => {
    const repo = new FakeUserScoreRepository();
    const handler = new IncrementScoreHandler(repo);
    const now = new Date('2025-06-01T12:00:00Z');

    const cmd = new IncrementScoreCommand({
      userId: USER,
      actionId: ACTION_A,
      delta: ScoreDelta.of(5),
      occurredAt: now,
    });

    await handler.execute(cmd); // first call succeeds

    // Second call with the same actionId must raise the domain error
    await expect(handler.execute(cmd)).rejects.toBeInstanceOf(
      IdempotencyViolationError,
    );
  });

  it('domain invariant violation aborts before persistence', async () => {
    const repo = new FakeUserScoreRepository();
    const creditSpy = jest.spyOn(repo, 'credit');
    const handler = new IncrementScoreHandler(repo);

    // Pre-seed an aggregate at MAX_SAFE_INTEGER so the next credit overflows
    const seeded = UserScore.rehydrate({
      userId: USER,
      totalScore: Number.MAX_SAFE_INTEGER,
      lastActionId: null,
      updatedAt: new Date(0),
    });
    // Inject directly into the fake's internal map without going through credit
    // so we can deterministically test the overflow path
    const findSpy = jest.spyOn(repo, 'findByUserId').mockResolvedValue(seeded);

    await expect(
      handler.execute(
        new IncrementScoreCommand({
          userId: USER,
          actionId: ACTION_A,
          delta: ScoreDelta.of(1),
          occurredAt: new Date(),
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidArgumentError);

    expect(findSpy).toHaveBeenCalledTimes(1);
    expect(creditSpy).not.toHaveBeenCalled();
  });

  it('response shape always includes rank: null and topChanged: null', async () => {
    const repo = new FakeUserScoreRepository();
    const handler = new IncrementScoreHandler(repo);

    const result = await handler.execute(
      new IncrementScoreCommand({
        userId: USER,
        actionId: ACTION_A,
        delta: ScoreDelta.of(1),
        occurredAt: new Date(),
      }),
    );

    expect(result).toHaveProperty('rank', null);
    expect(result).toHaveProperty('topChanged', null);
  });
});
