import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';

import { up as createResourcesUp } from '../../../migrations/0001_create_resources.js';

let pgContainer: StartedPostgreSqlContainer | undefined;
let redisContainer: StartedRedisContainer | undefined;

/**
 * Vitest global setup. Boots a single Postgres + Redis pair shared across
 * all integration test files in the run. Per-test isolation is handled by
 * `resetDatabase()` / `flushCache()` in `fixtures/db.ts`.
 */
export async function setup(): Promise<void> {
  pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('resources_test')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();

  redisContainer = await new RedisContainer('redis:7-alpine').start();

  const databaseUrl = pgContainer.getConnectionUri();
  const redisUrl = redisContainer.getConnectionUrl();

  // Expose via env so tests that construct deps (through createTestApp)
  // pick the container-backed clients up automatically.
  process.env['DATABASE_URL'] = databaseUrl;
  process.env['REDIS_URL'] = redisUrl;
  process.env['NODE_ENV'] = 'test';
  // Let every integration test speak to a live X-Cache header; the
  // production gate in xCacheMiddleware only suppresses on NODE_ENV=production.

  // Run migrations against the test Postgres instance using the same
  // migration code the production path uses. A short-lived pg pool + Kysely
  // is enough because we only need the `up` function to execute its SQL.
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
  try {
    await createResourcesUp(db);
  } finally {
    await db.destroy();
  }
}

export async function teardown(): Promise<void> {
  await pgContainer?.stop();
  await redisContainer?.stop();
}
