/**
 * Flush the Redis cache used by the resources API.
 *
 * Connects to REDIS_URL (default redis://localhost:6379), issues FLUSHDB,
 * then exits cleanly.
 *
 * Used by the cache-cold scenario setup to ensure every read hits Postgres
 * rather than the cache, establishing a cold-cache baseline.
 *
 * Usage:
 *   tsx benchmarks/seed/flush-cache.ts
 *
 * Env:
 *   REDIS_URL  Redis connection string (default: redis://localhost:6379)
 */

import Redis from 'ioredis';

async function main() {
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const redis = new Redis(redisUrl, { lazyConnect: true });

  try {
    await redis.connect();
    console.log(`Connected to Redis at ${redisUrl}`);
    await redis.flushdb();
    console.log('FLUSHDB complete — cache cleared.');
  } finally {
    await redis.quit();
  }
}

main().catch((err) => {
  console.error('flush-cache failed:', err);
  process.exit(1);
});
