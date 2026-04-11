import { randomUUID } from 'node:crypto';

import { KyselyUserScoreRepository } from '../../../src/scoreboard/infrastructure/persistence/kysely/user-score.repository.impl';
import { IdempotencyViolationError } from '../../../src/scoreboard/domain/errors/idempotency-violation.error';
import { ScoreCredited } from '../../../src/scoreboard/domain/events/score-credited.event';
import { UserScore } from '../../../src/scoreboard/domain/user-score.aggregate';
import { ActionId } from '../../../src/scoreboard/domain/value-objects/action-id';
import { ScoreDelta } from '../../../src/scoreboard/domain/value-objects/score-delta';
import { UserId } from '../../../src/scoreboard/domain/value-objects/user-id';
import { startPostgres, type PostgresHandle } from '../setup';

jest.setTimeout(90000);

describe('KyselyUserScoreRepository integration', () => {
  let handle: PostgresHandle;
  let repo: KyselyUserScoreRepository;

  beforeAll(async () => {
    handle = await startPostgres();
    repo = new KyselyUserScoreRepository(handle.db);
  });

  afterAll(async () => {
    await handle.db.destroy();
    await handle.container.stop();
  });

  function makeAggregate(userId: string, delta: number): { aggregate: UserScore; event: ScoreCredited } {
    const uid = UserId.of(userId);
    const aid = ActionId.of(randomUUID());
    const sd = ScoreDelta.of(delta);
    const aggregate = UserScore.empty(uid);
    const now = new Date();
    aggregate.credit(aid, sd, now);
    const [event] = aggregate.pullEvents() as ScoreCredited[];
    return { aggregate, event };
  }

  test('Test 1: round-trip credit for a new user', async () => {
    const userId = randomUUID();
    const { aggregate, event } = makeAggregate(userId, 10);

    await repo.credit(aggregate, event);

    const result = await repo.findByUserId(UserId.of(userId));
    expect(result).not.toBeNull();
    expect(result!.totalScore).toBe(10);
    expect(result!.lastActionId).toBe(event.actionId);
  });

  test('Test 2: round-trip credit for an existing user adds delta', async () => {
    const userId = randomUUID();

    // First credit
    const { aggregate: agg1, event: evt1 } = makeAggregate(userId, 15);
    await repo.credit(agg1, evt1);

    // Second credit on top
    const { aggregate: agg2, event: evt2 } = makeAggregate(userId, 25);
    await repo.credit(agg2, evt2);

    const result = await repo.findByUserId(UserId.of(userId));
    expect(result).not.toBeNull();
    expect(result!.totalScore).toBe(40);
    expect(result!.lastActionId).toBe(evt2.actionId);
  });

  test('Test 3: duplicate actionId throws IdempotencyViolationError', async () => {
    const userId = randomUUID();
    const { aggregate, event } = makeAggregate(userId, 5);

    await repo.credit(aggregate, event);

    // Second call with same event (same actionId)
    const aggDup = UserScore.empty(UserId.of(userId));
    const aidDup = ActionId.of(event.actionId);
    const sdDup = ScoreDelta.of(5);
    aggDup.credit(aidDup, sdDup, new Date());
    const [evtDup] = aggDup.pullEvents() as ScoreCredited[];

    await expect(repo.credit(aggDup, evtDup)).rejects.toThrow(IdempotencyViolationError);
  });

  test('Test 4: concurrent credits for the same user produce correct total (SELECT FOR UPDATE)', async () => {
    const userId = randomUUID();

    // Run two credits concurrently
    const [
      { aggregate: agg1, event: evt1 },
      { aggregate: agg2, event: evt2 },
    ] = [makeAggregate(userId, 7), makeAggregate(userId, 13)];

    await Promise.all([
      repo.credit(agg1, evt1),
      repo.credit(agg2, evt2),
    ]);

    const result = await repo.findByUserId(UserId.of(userId));
    expect(result).not.toBeNull();
    expect(result!.totalScore).toBe(20);
  });

  test('Test 5: findScoreEventByActionId returns the inserted record', async () => {
    const userId = randomUUID();
    const { aggregate, event } = makeAggregate(userId, 8);
    await repo.credit(aggregate, event);

    const record = await repo.findScoreEventByActionId(ActionId.of(event.actionId));
    expect(record).not.toBeNull();
    expect(record!.actionId).toBe(event.actionId);
    expect(record!.userId).toBe(event.userId);
    expect(record!.delta).toBe(8);
    expect(record!.totalScoreAfter).toBe(8);
  });

  test('Test 6: findByUserId returns null for unknown user', async () => {
    const result = await repo.findByUserId(UserId.of(randomUUID()));
    expect(result).toBeNull();
  });
});
