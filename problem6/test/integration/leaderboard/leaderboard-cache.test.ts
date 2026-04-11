import { randomUUID } from 'node:crypto';

import { RedisLeaderboardCache } from '../../../src/scoreboard/infrastructure/persistence/redis/leaderboard-cache.impl';
import { Score } from '../../../src/scoreboard/domain/value-objects/score';
import { UserId } from '../../../src/scoreboard/domain/value-objects/user-id';
import { startRedis, type RedisHandle } from '../setup';

jest.setTimeout(90000);

describe('RedisLeaderboardCache integration', () => {
  let handle: RedisHandle;
  let cache: RedisLeaderboardCache;

  beforeAll(async () => {
    handle = await startRedis();
    // Instantiate directly bypassing NestJS DI — matches redis-token-bucket.test.ts pattern
    cache = new RedisLeaderboardCache(handle.client as never);
  });

  afterAll(async () => {
    await handle.client.quit();
    await handle.container.stop();
  });

  // Flush ZSET between tests for isolation
  beforeEach(async () => {
    await handle.client.del('leaderboard:global');
  });

  function uid(): UserId {
    return UserId.of(randomUUID());
  }

  // ---------------------------------------------------------------------------
  // Test 1: upsert + getTop returns all entries in score-descending order
  // ---------------------------------------------------------------------------
  test('Test 1: upsert 5 users and getTop(10) returns all 5 in score-descending order', async () => {
    const now = new Date('2026-01-01T00:00:00Z');

    const users = [
      { id: uid(), score: 100 },
      { id: uid(), score: 90 },
      { id: uid(), score: 80 },
      { id: uid(), score: 70 },
      { id: uid(), score: 60 },
    ];

    for (const u of users) {
      await cache.upsert(u.id, Score.of(u.score), now);
    }

    const entries = await cache.getTop(10);

    expect(entries).toHaveLength(5);
    expect(entries.map((e) => e.score)).toEqual([100, 90, 80, 70, 60]);
    expect(entries.map((e) => e.rank)).toEqual([1, 2, 3, 4, 5]);
    for (const e of entries) {
      expect(typeof e.userId).toBe('string');
    }
  });

  // ---------------------------------------------------------------------------
  // Test 2: upsert idempotency — same userId with two different scores keeps latest
  // ---------------------------------------------------------------------------
  test('Test 2: upsert same user twice — second score replaces first (ZADD replace semantics)', async () => {
    const userId = uid();
    const now = new Date('2026-01-01T00:00:00Z');

    await cache.upsert(userId, Score.of(50), now);
    await cache.upsert(userId, Score.of(99), now);

    const entries = await cache.getTop(10);

    expect(entries).toHaveLength(1);
    expect(entries[0].score).toBe(99);
    expect(entries[0].userId).toBe(userId.value);
  });

  // ---------------------------------------------------------------------------
  // Test 3: getRank returns correct 1-indexed ranks
  // ---------------------------------------------------------------------------
  test('Test 3: getRank returns correct ranks for 3 users', async () => {
    const now = new Date('2026-01-01T00:00:00Z');

    const u1 = uid();
    const u2 = uid();
    const u3 = uid();

    await cache.upsert(u1, Score.of(300), now);
    await cache.upsert(u2, Score.of(200), now);
    await cache.upsert(u3, Score.of(100), now);

    const rank1 = await cache.getRank(u1);
    const rank2 = await cache.getRank(u2);
    const rank3 = await cache.getRank(u3);

    expect(rank1).toBe(1);
    expect(rank2).toBe(2);
    expect(rank3).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // Test 4: getRank for absent userId returns null
  // ---------------------------------------------------------------------------
  test('Test 4: getRank returns null for a userId that was never upserted', async () => {
    const absentUser = uid();
    const result = await cache.getRank(absentUser);
    expect(result).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Test 5: tie-break — same score, earlier updatedAt wins (higher rank)
  // GAP-01 decision: encoded = score * SCORE_SHIFT + (MAX_TS - updatedAtSeconds)
  // Earlier updatedAt → larger (MAX_TS - updatedAtSeconds) → higher rank
  // ---------------------------------------------------------------------------
  test('Test 5: tie-break — same score, earlier updatedAt gets higher rank', async () => {
    const userA = uid();
    const userB = uid();

    // userA was updated EARLIER (2026-01-01) — should be rank 1
    const updatedAtA = new Date('2026-01-01T00:00:00Z');
    // userB was updated LATER (2026-01-02) — should be rank 2
    const updatedAtB = new Date('2026-01-02T00:00:00Z');

    // Both have the same score (well below 2_097_151 lossless limit)
    await cache.upsert(userA, Score.of(100), updatedAtA);
    await cache.upsert(userB, Score.of(100), updatedAtB);

    const entries = await cache.getTop(10);

    expect(entries).toHaveLength(2);
    // userA (earlier update) must be first
    expect(entries[0].userId).toBe(userA.value);
    expect(entries[1].userId).toBe(userB.value);

    // Both have score 100
    expect(entries[0].score).toBe(100);
    expect(entries[1].score).toBe(100);

    // Rank checks via getRank
    const rankA = await cache.getRank(userA);
    const rankB = await cache.getRank(userB);
    expect(rankA).toBe(1);
    expect(rankB).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Test 6: singleflight — 100 concurrent getTop(10) collapse into one ZREVRANGE
  // ---------------------------------------------------------------------------
  test('Test 6: 100 concurrent getTop(10) calls issue exactly one ZREVRANGE', async () => {
    // Seed one entry so getTop has something meaningful to return
    const now = new Date('2026-01-01T00:00:00Z');
    await cache.upsert(uid(), Score.of(42), now);

    // Fresh cache instance so its Singleflight map starts empty
    const freshCache = new RedisLeaderboardCache(handle.client as never);
    const zrevrangeSpy = jest.spyOn(handle.client, 'zrevrange');

    try {
      const results = await Promise.all(
        Array.from({ length: 100 }, () => freshCache.getTop(10)),
      );

      expect(results).toHaveLength(100);
      for (const entries of results) {
        expect(entries).toHaveLength(1);
        expect(entries[0].score).toBe(42);
      }
      expect(zrevrangeSpy).toHaveBeenCalledTimes(1);
    } finally {
      zrevrangeSpy.mockRestore();
    }
  });
});
