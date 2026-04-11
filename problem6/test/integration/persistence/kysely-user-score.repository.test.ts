import { randomUUID } from 'node:crypto';

import { KyselyUserScoreRepository } from '../../../src/scoreboard/infrastructure/persistence/kysely/user-score.repository.impl';
import { IdempotencyViolationError } from '../../../src/scoreboard/domain/errors/idempotency-violation.error';
import { ScoreCredited } from '../../../src/scoreboard/domain/events/score-credited.event';
import type { OutboxRow } from '../../../src/scoreboard/domain/ports/user-score.repository';
import { UserScore } from '../../../src/scoreboard/domain/user-score.aggregate';
import { ActionId } from '../../../src/scoreboard/domain/value-objects/action-id';
import { ScoreDelta } from '../../../src/scoreboard/domain/value-objects/score-delta';
import { UserId } from '../../../src/scoreboard/domain/value-objects/user-id';
import { startPostgres, type PostgresHandle } from '../setup';

jest.setTimeout(90000);

function makeOutboxRow(userId: string, actionId: string, delta: number, newTotal: number): OutboxRow {
  return {
    aggregateId: userId,
    eventType: 'scoreboard.score.credited',
    payload: { userId, actionId, delta, newTotal, occurredAt: new Date().toISOString() },
  };
}

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
    const outboxRow = makeOutboxRow(userId, event.actionId, event.delta, aggregate.totalScore);

    await repo.credit(aggregate, event, outboxRow);

    const result = await repo.findByUserId(UserId.of(userId));
    expect(result).not.toBeNull();
    expect(result!.totalScore).toBe(10);
    expect(result!.lastActionId).toBe(event.actionId);
  });

  test('Test 1b: outbox row is inserted inside the same transaction', async () => {
    const userId = randomUUID();
    const { aggregate, event } = makeAggregate(userId, 5);
    const outboxRow = makeOutboxRow(userId, event.actionId, event.delta, aggregate.totalScore);

    await repo.credit(aggregate, event, outboxRow);

    // Verify the outbox row was inserted
    const outboxRecord = await handle.db
      .selectFrom('outbox_events')
      .where('aggregate_id', '=', userId)
      .selectAll()
      .executeTakeFirst();

    expect(outboxRecord).not.toBeUndefined();
    expect(outboxRecord!.aggregate_id).toBe(userId);
    expect(outboxRecord!.event_type).toBe('scoreboard.score.credited');
    expect(outboxRecord!.published_at).toBeNull();
  });

  test('Test 1c: outbox row payload contains required fields (userId, actionId, delta, newTotal, occurredAt)', async () => {
    const userId = randomUUID();
    const delta = 42;
    const { aggregate, event } = makeAggregate(userId, delta);
    const outboxRow = makeOutboxRow(userId, event.actionId, event.delta, aggregate.totalScore);

    await repo.credit(aggregate, event, outboxRow);

    const outboxRecord = await handle.db
      .selectFrom('outbox_events')
      .where('aggregate_id', '=', userId)
      .selectAll()
      .executeTakeFirst();

    expect(outboxRecord).not.toBeUndefined();

    // created_at should be set (not null)
    expect(outboxRecord!.created_at).not.toBeNull();
    expect(outboxRecord!.created_at).toBeTruthy();

    // published_at must be null (event not yet published)
    expect(outboxRecord!.published_at).toBeNull();

    // Validate payload shape
    const payload = outboxRecord!.payload as Record<string, unknown>;
    expect(typeof payload).toBe('object');
    expect(payload['userId']).toBe(userId);
    expect(payload['actionId']).toBe(event.actionId);
    expect(payload['delta']).toBe(delta);
    expect(payload['newTotal']).toBe(aggregate.totalScore);
    expect(typeof payload['occurredAt']).toBe('string');
    // occurredAt should be a valid ISO date string
    expect(new Date(payload['occurredAt'] as string).getTime()).not.toBeNaN();
  });

  test('Test 2: round-trip credit for an existing user adds delta', async () => {
    const userId = randomUUID();

    // First credit
    const { aggregate: agg1, event: evt1 } = makeAggregate(userId, 15);
    await repo.credit(agg1, evt1, makeOutboxRow(userId, evt1.actionId, evt1.delta, agg1.totalScore));

    // Second credit on top
    const { aggregate: agg2, event: evt2 } = makeAggregate(userId, 25);
    await repo.credit(agg2, evt2, makeOutboxRow(userId, evt2.actionId, evt2.delta, agg2.totalScore));

    const result = await repo.findByUserId(UserId.of(userId));
    expect(result).not.toBeNull();
    expect(result!.totalScore).toBe(40);
    expect(result!.lastActionId).toBe(evt2.actionId);
  });

  test('Test 3: duplicate actionId throws IdempotencyViolationError', async () => {
    const userId = randomUUID();
    const { aggregate, event } = makeAggregate(userId, 5);

    await repo.credit(aggregate, event, makeOutboxRow(userId, event.actionId, event.delta, aggregate.totalScore));

    // Second call with same event (same actionId)
    const aggDup = UserScore.empty(UserId.of(userId));
    const aidDup = ActionId.of(event.actionId);
    const sdDup = ScoreDelta.of(5);
    aggDup.credit(aidDup, sdDup, new Date());
    const [evtDup] = aggDup.pullEvents() as ScoreCredited[];

    await expect(
      repo.credit(aggDup, evtDup, makeOutboxRow(userId, evtDup.actionId, evtDup.delta, aggDup.totalScore)),
    ).rejects.toThrow(IdempotencyViolationError);
  });

  test('Test 4: concurrent credits for the same user produce correct total (SELECT FOR UPDATE)', async () => {
    const userId = randomUUID();

    // Run two credits concurrently
    const [
      { aggregate: agg1, event: evt1 },
      { aggregate: agg2, event: evt2 },
    ] = [makeAggregate(userId, 7), makeAggregate(userId, 13)];

    await Promise.all([
      repo.credit(agg1, evt1, makeOutboxRow(userId, evt1.actionId, evt1.delta, agg1.totalScore)),
      repo.credit(agg2, evt2, makeOutboxRow(userId, evt2.actionId, evt2.delta, agg2.totalScore)),
    ]);

    const result = await repo.findByUserId(UserId.of(userId));
    expect(result).not.toBeNull();
    expect(result!.totalScore).toBe(20);
  });

  test('Test 5: findScoreEventByActionId returns the inserted record', async () => {
    const userId = randomUUID();
    const { aggregate, event } = makeAggregate(userId, 8);
    await repo.credit(aggregate, event, makeOutboxRow(userId, event.actionId, event.delta, aggregate.totalScore));

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
