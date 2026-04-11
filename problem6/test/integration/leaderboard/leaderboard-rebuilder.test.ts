import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';

import { ConfigService } from '../../../src/config';
import { LeaderboardRebuilder } from '../../../src/scoreboard/infrastructure/persistence/redis/leaderboard-rebuilder';
import { startPostgres, startRedis, type PostgresHandle, type RedisHandle } from '../setup';

jest.setTimeout(120000);

// ---------------------------------------------------------------------------
// Minimal ConfigService mock — returns LEADERBOARD_REBUILD_TOP_N or undefined
// ---------------------------------------------------------------------------
function makeConfig(topN: number): ConfigService {
  return {
    get: (key: string) =>
      key === 'LEADERBOARD_REBUILD_TOP_N' ? topN : (undefined as unknown),
  } as unknown as ConfigService;
}

// ---------------------------------------------------------------------------
// Silence NestJS Logger during tests
// ---------------------------------------------------------------------------
beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('LeaderboardRebuilder integration', () => {
  let pg: PostgresHandle;
  let redis: RedisHandle;
  let rebuilder: LeaderboardRebuilder;

  beforeAll(async () => {
    [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
    rebuilder = new LeaderboardRebuilder(
      pg.db as never,
      redis.client as never,
      makeConfig(10000),
    );
  });

  afterAll(async () => {
    await pg.db.destroy();
    await pg.container.stop();
    await redis.client.quit();
    await redis.container.stop();
  });

  // Flush ZSET and truncate tables between tests for isolation
  beforeEach(async () => {
    await redis.client.del('leaderboard:global');
    await redis.client.del('leaderboard:rebuild:lock');
    await pg.db.deleteFrom('score_events').execute();
    await pg.db.deleteFrom('outbox_events').execute();
    await pg.db.deleteFrom('user_scores').execute();
  });

  // ---------------------------------------------------------------------------
  // Helper: seed user_scores with N rows
  // ---------------------------------------------------------------------------
  async function seedUserScores(
    count: number,
    baseScore = 0,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const userId = randomUUID();
      ids.push(userId);
      // Vary scores so ordering is deterministic: user i gets score (count - i)
      await pg.db
        .insertInto('user_scores')
        .values({
          user_id: userId,
          total_score: baseScore + (count - i),
          last_action_id: randomUUID(),
          updated_at: new Date(Date.now() + i * 1000).toISOString(),
        })
        .execute();
    }
    return ids;
  }

  // ---------------------------------------------------------------------------
  // Test 1: rebuild populates ZSET from Postgres
  // ---------------------------------------------------------------------------
  test('Test 1: empty Redis + 25 users in Postgres → rebuild populates ZSET with all 25', async () => {
    await seedUserScores(25);

    const result = await rebuilder.rebuild();

    const card = await redis.client.zcard('leaderboard:global');
    expect(card).toBe(25);
    expect(result.usersProcessed).toBe(25);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);

    // getTop(10) should return 10 entries in score-descending order
    const top10 = await redis.client.zrevrange(
      'leaderboard:global',
      0,
      9,
      'WITHSCORES',
    );
    // top10 is [userId, encodedScore, userId, encodedScore, ...]
    const scores: number[] = [];
    for (let i = 1; i < top10.length; i += 2) {
      scores.push(parseFloat(top10[i]));
    }
    // Scores should be monotonically non-increasing
    for (let i = 0; i < scores.length - 1; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i + 1]);
    }
  });

  // ---------------------------------------------------------------------------
  // Test 2: top-N cap is respected
  // ---------------------------------------------------------------------------
  test('Test 2: LEADERBOARD_REBUILD_TOP_N=10 caps ZSET at 10 even with 25 rows', async () => {
    await seedUserScores(25);

    // Override the config for this test
    const rebuilderWith10 = new LeaderboardRebuilder(
      pg.db as never,
      redis.client as never,
      makeConfig(10),
    );

    const result = await rebuilderWith10.rebuild();

    const card = await redis.client.zcard('leaderboard:global');
    expect(card).toBe(10);
    expect(result.usersProcessed).toBe(10);
  });

  // ---------------------------------------------------------------------------
  // Test 3: lock contention — external lock blocks rebuild
  // ---------------------------------------------------------------------------
  test('Test 3: if rebuild lock is already held, rebuild returns early with usersProcessed=0', async () => {
    await seedUserScores(5);

    // Manually acquire the lock so the rebuilder cannot proceed
    await redis.client.set('leaderboard:rebuild:lock', 'external-holder', 'EX', 300, 'NX');

    const result = await rebuilder.rebuild();

    expect(result.usersProcessed).toBe(0);
    expect(result.elapsedMs).toBe(0);

    // ZSET should still be empty — rebuild was skipped
    const card = await redis.client.zcard('leaderboard:global');
    expect(card).toBe(0);

    // Now release the lock and verify rebuild works
    await redis.client.del('leaderboard:rebuild:lock');
    const result2 = await rebuilder.rebuild();
    expect(result2.usersProcessed).toBe(5);
    const card2 = await redis.client.zcard('leaderboard:global');
    expect(card2).toBe(5);
  });

  // ---------------------------------------------------------------------------
  // Test 4: lock is released after successful rebuild
  // ---------------------------------------------------------------------------
  test('Test 4: lock is released after a successful rebuild', async () => {
    await seedUserScores(5);

    await rebuilder.rebuild();

    // The lock key should NOT exist after a successful rebuild
    const lockExists = await redis.client.exists('leaderboard:rebuild:lock');
    expect(lockExists).toBe(0);
  });
});
