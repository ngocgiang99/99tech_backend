import { randomUUID } from 'node:crypto';

import { startRedis, type RedisHandle } from '../setup';

jest.setTimeout(90000);

describe('Redis idempotency (SETNX semantics)', () => {
  let handle: RedisHandle;

  beforeAll(async () => {
    handle = await startRedis();
  });

  afterAll(async () => {
    await handle.client.quit();
    await handle.container.stop();
  });

  function idempotencyKey(actionId: string): string {
    return `idempotency:action:${actionId}`;
  }

  test('Test 1: SETNX win — first SET NX returns OK', async () => {
    const key = idempotencyKey(randomUUID());
    const result = await handle.client.set(key, '1', 'EX', 300, 'NX');
    expect(result).toBe('OK');
  });

  test('Test 2: SETNX loss — second SET NX on the same key returns null', async () => {
    const key = idempotencyKey(randomUUID());
    const first = await handle.client.set(key, '1', 'EX', 300, 'NX');
    expect(first).toBe('OK');

    const second = await handle.client.set(key, '1', 'EX', 300, 'NX');
    expect(second).toBeNull();
  });

  // Marked slow — waits 1100ms for TTL to expire
  test('Test 3: TTL expiry — after EX 1 the key expires and SETNX wins again', async () => {
    jest.setTimeout(10000);
    const key = idempotencyKey(randomUUID());

    const first = await handle.client.set(key, '1', 'EX', 1, 'NX');
    expect(first).toBe('OK');

    // Wait for the 1-second TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const second = await handle.client.set(key, '1', 'EX', 300, 'NX');
    expect(second).toBe('OK');
  });
});
