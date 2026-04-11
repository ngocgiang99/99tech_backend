// ---------------------------------------------------------------------------
// Mock shared/metrics before any imports that transitively load it
// ---------------------------------------------------------------------------

jest.mock('../../../src/shared/metrics', () => ({
  METRIC_SCORE_INCREMENT_TOTAL: 'metric.scoreboard_score_increment_total',
  scoreIncrementTotal: { inc: jest.fn() },
}));

import { IncrementScoreCommand } from '../../../src/scoreboard/application/commands/increment-score.command';
import { IncrementScoreHandler } from '../../../src/scoreboard/application/commands/increment-score.handler';
import { IdempotencyViolationError } from '../../../src/scoreboard/domain/errors/idempotency-violation.error';
import { InvalidArgumentError } from '../../../src/scoreboard/domain/errors/invalid-argument.error';
import type {
  LeaderboardCache,
  LeaderboardEntry,
} from '../../../src/scoreboard/domain/ports/leaderboard-cache';
import { UserScore } from '../../../src/scoreboard/domain/user-score.aggregate';
import { ActionId } from '../../../src/scoreboard/domain/value-objects/action-id';
import { ScoreDelta } from '../../../src/scoreboard/domain/value-objects/score-delta';
import { Score } from '../../../src/scoreboard/domain/value-objects/score';
import { UserId } from '../../../src/scoreboard/domain/value-objects/user-id';

import { FakeUserScoreRepository } from './fakes/fake-user-score.repository';

const USER = UserId.of('550e8400-e29b-41d4-a716-446655440000');
const ACTION_A = ActionId.of('11111111-1111-1111-1111-111111111111');
const ACTION_B = ActionId.of('22222222-2222-2222-2222-222222222222');

function makeCounter() {
  return { inc: jest.fn() };
}

// ---------------------------------------------------------------------------
// Inline FakeLeaderboardCache for handler tests
// ---------------------------------------------------------------------------

class FakeLeaderboardCache implements LeaderboardCache {
  private readonly store = new Map<
    string,
    { score: Score; updatedAt: Date }
  >();

  /** If set, upsert() will throw this error */
  upsertError: Error | null = null;
  /** If set, getRank() will throw this error */
  getRankError: Error | null = null;
  /** Configurable rank to return from getRank() */
  rankToReturn: number | null = 1;
  /** Configurable top list to return from getTop() */
  topToReturn: LeaderboardEntry[] = [];

  async upsert(userId: UserId, score: Score, updatedAt: Date): Promise<void> {
    if (this.upsertError) throw this.upsertError;
    this.store.set(userId.value, { score, updatedAt });
  }

  async getRank(_userId: UserId): Promise<number | null> {
    if (this.getRankError) throw this.getRankError;
    return this.rankToReturn;
  }

  async getTop(n: number): Promise<LeaderboardEntry[]> {
    return this.topToReturn.slice(0, n);
  }
}

function makeHandler(
  repo: FakeUserScoreRepository,
  cache: LeaderboardCache,
): IncrementScoreHandler {
  return new IncrementScoreHandler(
    repo,
    makeCounter() as never,
    cache,
  );
}

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
    await repo.credit(seeded, seedEvent, [
      {
        aggregateId: USER.value,
        eventType: 'scoreboard.score.credited',
        payload: { userId: USER.value, delta: 1, newTotal: 101, occurredAt: new Date('2025-01-01T00:00:00Z').toISOString() },
      },
    ]);

    const cache = new FakeLeaderboardCache();
    cache.rankToReturn = null;
    cache.topToReturn = [];
    const handler = makeHandler(repo, cache);
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
      kind: 'committed',
      userId: USER.value,
      newScore: 111, // 100 + 1 seed + 10
      rank: null,
      topChanged: false,
    });
  });

  it('new user (no existing row) starts from UserScore.empty', async () => {
    const repo = new FakeUserScoreRepository();
    const cache = new FakeLeaderboardCache();
    cache.rankToReturn = null;
    cache.topToReturn = [];
    const handler = makeHandler(repo, cache);
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
      kind: 'committed',
      userId: USER.value,
      newScore: 7,
      rank: null,
      topChanged: false,
    });

    // Verify the fake stored the updated aggregate
    const stored = await repo.findByUserId(USER);
    expect(stored).not.toBeNull();
    expect(stored!.totalScore).toBe(7);
    expect(stored!.lastActionId).toBe(ACTION_A.value);
  });

  it('idempotent replay of the same actionId returns kind: idempotent-replay with prior totalScoreAfter', async () => {
    const repo = new FakeUserScoreRepository();
    const cache = new FakeLeaderboardCache();
    const handler = makeHandler(repo, cache);
    const now = new Date('2025-06-01T12:00:00Z');

    const cmd = new IncrementScoreCommand({
      userId: USER,
      actionId: ACTION_A,
      delta: ScoreDelta.of(5),
      occurredAt: now,
    });

    // First call commits 5 and records the prior score event in the fake.
    await handler.execute(cmd);

    // Second call sees the IdempotencyViolationError inside the handler, looks
    // up the prior event, and returns the historical outcome tagged idempotent-replay.
    const replayResult = await handler.execute(cmd);

    expect(replayResult).toEqual({
      kind: 'idempotent-replay',
      userId: USER.value,
      newScore: 5,
      rank: null,
      topChanged: null,
    });
  });

  it('idempotent replay with missing prior event throws InternalError', async () => {
    const repo = new FakeUserScoreRepository();
    // Force credit() to throw IdempotencyViolationError but findScoreEventByActionId() to return null
    jest
      .spyOn(repo, 'credit')
      .mockRejectedValueOnce(new IdempotencyViolationError(ACTION_A.value));
    jest.spyOn(repo, 'findScoreEventByActionId').mockResolvedValueOnce(null);
    const cache = new FakeLeaderboardCache();
    const handler = makeHandler(repo, cache);

    await expect(
      handler.execute(
        new IncrementScoreCommand({
          userId: USER,
          actionId: ACTION_A,
          delta: ScoreDelta.of(5),
          occurredAt: new Date(),
        }),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('Prior credit record not found') });
  });

  it('domain invariant violation aborts before persistence', async () => {
    const repo = new FakeUserScoreRepository();
    const creditSpy = jest.spyOn(repo, 'credit');
    const cache = new FakeLeaderboardCache();
    const handler = makeHandler(repo, cache);

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

  it('increments the scoreIncrementTotal counter with result=committed on success', async () => {
    const repo = new FakeUserScoreRepository();
    const counter = makeCounter();
    const cache = new FakeLeaderboardCache();
    const handler = new IncrementScoreHandler(
      repo,
      counter as never,
      cache,
    );

    await handler.execute(
      new IncrementScoreCommand({
        userId: USER,
        actionId: ACTION_A,
        delta: ScoreDelta.of(5),
        occurredAt: new Date(),
      }),
    );

    expect(counter.inc).toHaveBeenCalledWith({ result: 'committed' });
  });

  // ---------------------------------------------------------------------------
  // Outbox row tests
  // ---------------------------------------------------------------------------

  it('stores outbox rows in the fake repository with correct shape (credited + leaderboard.updated)', async () => {
    const repo = new FakeUserScoreRepository();
    const cache = new FakeLeaderboardCache();
    const handler = makeHandler(repo, cache);
    const now = new Date('2025-06-01T12:00:00Z');

    await handler.execute(
      new IncrementScoreCommand({
        userId: USER,
        actionId: ACTION_A,
        delta: ScoreDelta.of(42),
        occurredAt: now,
      }),
    );

    // The handler writes two outbox rows atomically: the raw score.credited
    // audit event AND a leaderboard.updated event for the SSE fan-out path.
    // The outbox publisher's coalescing logic (step-06) decides whether to
    // actually publish the leaderboard.updated message.
    expect(repo.outboxRows).toHaveLength(2);

    const credited = repo.outboxRows.find(
      (r) => r.eventType === 'scoreboard.score.credited',
    );
    expect(credited).toBeDefined();
    expect(credited!.aggregateId).toBe(USER.value);
    expect(credited!.payload).toMatchObject({
      userId: USER.value,
      actionId: ACTION_A.value,
      delta: 42,
      newTotal: 42,
    });

    const leaderboardUpdated = repo.outboxRows.find(
      (r) => r.eventType === 'scoreboard.leaderboard.updated',
    );
    expect(leaderboardUpdated).toBeDefined();
    expect(leaderboardUpdated!.aggregateId).toBe(USER.value);
    expect(leaderboardUpdated!.payload).toMatchObject({
      userId: USER.value,
      newTotal: 42,
    });
  });

  // ---------------------------------------------------------------------------
  // LeaderboardCache integration tests
  // ---------------------------------------------------------------------------

  it('happy path: cache returns populated rank + top → DTO has non-null rank and topChanged', async () => {
    const repo = new FakeUserScoreRepository();
    const cache = new FakeLeaderboardCache();
    cache.rankToReturn = 3;
    cache.topToReturn = [
      { rank: 1, userId: 'other-user-1', score: 100, updatedAt: new Date() },
      { rank: 2, userId: 'other-user-2', score: 90, updatedAt: new Date() },
      { rank: 3, userId: USER.value, score: 50, updatedAt: new Date() },
    ];
    const handler = makeHandler(repo, cache);

    const result = await handler.execute(
      new IncrementScoreCommand({
        userId: USER,
        actionId: ACTION_A,
        delta: ScoreDelta.of(50),
        occurredAt: new Date(),
      }),
    );

    expect(result.rank).toBe(3);
    expect(result.topChanged).toBe(true);
  });

  it('cache upsert throws → DTO has rank: null, topChanged: null, handler resolves normally', async () => {
    const repo = new FakeUserScoreRepository();
    const cache = new FakeLeaderboardCache();
    cache.upsertError = new Error('Redis connection refused');
    const handler = makeHandler(repo, cache);

    const result = await handler.execute(
      new IncrementScoreCommand({
        userId: USER,
        actionId: ACTION_A,
        delta: ScoreDelta.of(5),
        occurredAt: new Date(),
      }),
    );

    expect(result.rank).toBeNull();
    expect(result.topChanged).toBeNull();
    expect(result.newScore).toBe(5); // score is still committed
  });

  it('upsert succeeds but getRank throws → DTO has rank: null, topChanged: null, handler resolves normally', async () => {
    const repo = new FakeUserScoreRepository();
    const cache = new FakeLeaderboardCache();
    cache.getRankError = new Error('Redis timeout');
    const handler = makeHandler(repo, cache);

    const result = await handler.execute(
      new IncrementScoreCommand({
        userId: USER,
        actionId: ACTION_A,
        delta: ScoreDelta.of(5),
        occurredAt: new Date(),
      }),
    );

    expect(result.rank).toBeNull();
    expect(result.topChanged).toBeNull();
    expect(result.newScore).toBe(5); // score is still committed
  });

  it('cache throws a non-Error value → String(err) branch is hit, handler resolves normally', async () => {
    const repo = new FakeUserScoreRepository();
    const cache = new FakeLeaderboardCache();
    // Throw a plain string (non-Error) to exercise the String(err) branch in the catch
    cache.upsertError = 'plain string throw' as unknown as Error;
    const handler = makeHandler(repo, cache);

    const result = await handler.execute(
      new IncrementScoreCommand({
        userId: USER,
        actionId: ACTION_A,
        delta: ScoreDelta.of(5),
        occurredAt: new Date(),
      }),
    );

    expect(result.rank).toBeNull();
    expect(result.topChanged).toBeNull();
    expect(result.newScore).toBe(5);
  });
});
