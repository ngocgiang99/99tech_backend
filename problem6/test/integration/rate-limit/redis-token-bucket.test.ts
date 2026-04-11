import { randomUUID } from 'node:crypto';

import { RedisTokenBucket } from '../../../src/scoreboard/infrastructure/rate-limit/redis-token-bucket';
import { startRedis, type RedisHandle } from '../setup';

jest.setTimeout(90000);

describe('RedisTokenBucket integration', () => {
  let handle: RedisHandle;
  let bucket: RedisTokenBucket;

  beforeAll(async () => {
    handle = await startRedis();
    // RedisTokenBucket uses @Inject('Redis') — instantiate directly bypassing NestJS DI
    bucket = new RedisTokenBucket(handle.client as never);
    await bucket.onModuleInit();
  });

  afterAll(async () => {
    await handle.client.quit();
    await handle.container.stop();
  });

  test('Test 1: bucket admit — first N requests within capacity are all allowed', async () => {
    const userId = `u-${randomUUID()}`;
    const capacity = 10;
    const refillPerSec = 5;

    const results: boolean[] = [];
    for (let i = 0; i < capacity; i++) {
      const r = await bucket.consume(userId, capacity, refillPerSec);
      results.push(r.allowed);
    }

    expect(results.every((a) => a)).toBe(true);
  });

  test('Test 2: bucket reject — request beyond capacity is rejected with retryAfterMs', async () => {
    const userId = `u-${randomUUID()}`;
    const capacity = 3;
    const refillPerSec = 5;

    // Exhaust bucket
    for (let i = 0; i < capacity; i++) {
      await bucket.consume(userId, capacity, refillPerSec);
    }

    const rejected = await bucket.consume(userId, capacity, refillPerSec);
    expect(rejected.allowed).toBe(false);
    expect(typeof rejected.retryAfterMs).toBe('number');
    expect(rejected.retryAfterMs!).toBeGreaterThan(0);
  });

  test('Test 3: NOSCRIPT recovery — SCRIPT FLUSH forces reload, consume still works', async () => {
    const userId = `u-${randomUUID()}`;
    const capacity = 10;
    const refillPerSec = 5;

    // First call loads the script normally
    const before = await bucket.consume(userId, capacity, refillPerSec);
    expect(before.allowed).toBe(true);

    // Flush all loaded scripts from Redis
    await handle.client.script('FLUSH');

    // Next call should catch NOSCRIPT, reload, and succeed
    const after = await bucket.consume(userId, capacity, refillPerSec);
    expect(after.allowed).toBe(true);
  });

  test('Test 4: per-user isolation — u1 and u2 have independent buckets', async () => {
    const u1 = `u-${randomUUID()}`;
    const u2 = `u-${randomUUID()}`;
    const capacity = 2;
    const refillPerSec = 5;

    // Exhaust u1
    for (let i = 0; i < capacity; i++) {
      await bucket.consume(u1, capacity, refillPerSec);
    }
    const u1Rejected = await bucket.consume(u1, capacity, refillPerSec);

    // u2 should still be fresh
    const u2Allowed = await bucket.consume(u2, capacity, refillPerSec);

    expect(u1Rejected.allowed).toBe(false);
    expect(u2Allowed.allowed).toBe(true);
  });
});
